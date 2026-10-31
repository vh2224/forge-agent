#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const workerThreads = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const inventory = require('./forge-source-manifest');
const codex = require('./forge-codex-renderer');
const claude = require('./forge-claude-renderer');
const capabilities = require('./forge-capabilities');
const forgeHome = require('./forge-home');
const personal = require('./forge-personal-context');
const questions = require('./forge-pending-questions');
const core = require('./forge-panel-source');
const { sha256 } = require('./forge-delivery');
const records = require('./fixtures/agent-view/records.json');

const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extensions', 'forge-vscode');
const extensionFile = path.join(extensionRoot, 'extension.js');
const modelFile = path.join(extensionRoot, 'forge-panel-model.js');
const readerFile = path.join(extensionRoot, 'forge-panel-reader.js');
const coreFile = path.join(root, 'scripts', 'forge-panel-source.js');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const model = require(modelFile);
const reader = require(readerFile);
// Physical temp root: every locator and realpath comparison below is link-free.
const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-vscode-panel-'));
const now = records.now;
const ENV_KEYS = ['HOME', 'USERPROFILE', 'FORGE_HOME'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}
function pass(name) { console.log(`PASS S05/T02 ${name}`); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
function scenario(name) {
  const cwd = path.join(temp, name), userHome = path.join(temp, `${name}-home`);
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  return { cwd, project: cwd, userHome, env: { ...process.env, HOME: userHome, USERPROFILE: userHome, FORGE_HOME: path.join(userHome, '.forge-agent') } };
}
function bind(options, id = 'M001') {
  const state = write(path.join(options.cwd, `.gsd/milestones/${id}/${id}-STATE.md`),
    `---\nmilestone: ${id}\nkind: milestone\n---\n**Phase:** execute-task\n**Active Slice:** S05\n**Active Task:** T02\n**Next Action:** Conferir painel\n`);
  assert.equal(personal.bindWork({ ...options, id, intent: 'create' }).status, 'ok');
  return state;
}
function events(options, names = ['recent', 'native-with-id', 'heartbeat-only']) {
  const rows = names.flatMap(name => records.cases.find(row => row.name === name).records.map(row => ({ ...row, dispatch_id: `dispatch-${name}` })));
  return write(path.join(options.cwd, '.gsd/forge/events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function tree(dir) {
  const result = {};
  function walk(file) {
    const stat = fs.lstatSync(file), key = path.relative(dir, file);
    result[key] = [stat.mtimeMs, stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? fs.readdirSync(file).sort() : sha256(fs.readFileSync(file))];
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name));
  }
  walk(dir);
  return result;
}
// Every item a provider exposes, recursively, through getTreeItem only.
function render(provider, element) {
  return provider.getChildren(element).map(child => {
    const item = provider.getTreeItem(child);
    assert(Object.isFrozen(item) && Object.isFrozen(child));
    assert.deepEqual(Object.keys(item).sort(), ['collapsibleState', 'description', 'id', 'label', 'tooltip']);
    assert(!Object.hasOwn(item, 'command') && !Object.hasOwn(item, 'contextValue'));
    assert([0, 1].includes(item.collapsibleState));
    return { ...item, children: render(provider, child) };
  });
}
function ids(items) { return items.flatMap(item => [item.id, ...ids(item.children)]); }
function texts(items) { return items.flatMap(item => [item.label, item.description, item.tooltip, ...texts(item.children)]); }
function direct(nodes) { return render({ getChildren: element => model.getChildren(nodes, element), getTreeItem: model.getTreeItem }); }

class FakeWorker extends EventEmitter {
  constructor(file, options) { super(); this.file = file; this.options = options; this.terminated = 0; FakeWorker.created.push(this); }
  terminate() { this.terminated += 1; this.emit('exit', 1); return Promise.resolve(1); }
  reply(dto) { this.emit('message', { ok: true, dto }); }
}
FakeWorker.created = [];
class AutoWorker extends FakeWorker {
  constructor(file, options) { super(file, options); setImmediate(() => this.reply(AutoWorker.dto)); }
}

(async () => {
  // ── Package contract ────────────────────────────────────────────────────
  assert.deepEqual(Object.keys(manifest).sort(), ['activationEvents', 'capabilities', 'contributes', 'description', 'displayName',
    'engines', 'extensionKind', 'main', 'name', 'private', 'publisher', 'version']);
  assert.equal(manifest.private, true);
  assert.equal(manifest.name, 'forge-vscode');
  assert.equal(manifest.publisher, 'forge-agent');
  assert.equal(manifest.version, '0.1.0');
  assert.match(manifest.description, /somente leitura/);
  assert.match(manifest.description, /sem dados sintéticos/);
  assert.equal(manifest.engines.vscode, '^1.90.0');
  assert.equal(manifest.main, './extension.js');
  assert.equal(path.resolve(extensionRoot, manifest.main), extensionFile);
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.deepEqual(manifest.activationEvents, ['onView:forge.work']);
  assert.deepEqual(manifest.capabilities, { untrustedWorkspaces: { supported: true }, virtualWorkspaces: true });
  assert.deepEqual(Object.keys(manifest.contributes).sort(), ['commands', 'menus', 'views', 'viewsContainers']);
  assert.deepEqual(manifest.contributes.viewsContainers, { activitybar: [{ id: 'forge', title: 'Forge', icon: 'media/forge.svg' }] });
  assert.deepEqual(manifest.contributes.views, { forge: [{ id: 'forge.work', name: 'Trabalho' }] });
  assert.deepEqual(manifest.contributes.commands, [{ command: 'forge.work.refresh', title: 'Atualizar', category: 'Forge', icon: '$(refresh)' }]);
  assert.deepEqual(manifest.contributes.menus, {
    'view/title': [{ command: 'forge.work.refresh', when: 'view == forge.work', group: 'navigation' }],
    commandPalette: [{ command: 'forge.work.refresh', when: 'false' }],
  });
  for (const key of ['dependencies', 'devDependencies', 'scripts', 'extensionDependencies', 'configuration', 'webview', 'webviews']) {
    assert(!Object.hasOwn(manifest, key), key);
    assert(!Object.hasOwn(manifest.contributes, key), key);
  }
  const icon = fs.readFileSync(path.join(extensionRoot, manifest.contributes.viewsContainers.activitybar[0].icon), 'utf8');
  assert.match(icon, /<svg\b/);
  assert(!/script|href|onload|foreignObject/i.test(icon));
  pass('package: private 0.1.0 workspace extension, one view, one hidden-from-palette refresh command, local icon');

  // ── Runtime closure and static scan ─────────────────────────────────────
  const allowedImports = {
    [extensionFile]: ['./forge-panel-model', './forge-panel-reader', 'vscode'],
    [readerFile]: ['./forge-panel-model', 'node:fs', 'node:os', 'node:path', 'node:worker_threads'],
    [modelFile]: [],
  };
  const forbidden = /\b(?:http|https|net|tls|dgram|child_process|createServer|listen|createWebviewPanel|registerWebviewViewProvider|openExternal|clipboard|applyEdit|createTerminal|tasks|debug|showInputBox|showQuickPick|createFileSystemWatcher|setInterval|eval|Function|fetch|WebSocket|import)\b|workspace\.fs\b/;
  const closure = new Set();
  function inspectRuntime(file) {
    if (closure.has(file)) return;
    closure.add(file);
    assert(file.startsWith(extensionRoot + path.sep) && path.relative(extensionRoot, file).split(path.sep)[0] !== 'test');
    const source = fs.readFileSync(file, 'utf8');
    assert(!forbidden.test(source), `prohibited API in ${path.basename(file)}: ${source.match(forbidden)}`);
    assert(!/sint[eé]tic|synthetic/i.test(source), `synthetic data in ${path.basename(file)}`);
    assert(!/\b(?:TODO|TBD|FIXME)\b/.test(source));
    const literal = [...source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map(match => match[2]);
    const calls = (source.match(/\brequire\s*\(/g) || []).length;
    assert.deepEqual([...literal].sort(), allowedImports[file], `imports of ${path.basename(file)}`);
    if (file === readerFile) {
      // Exactly one dynamic require: the validated core path inside the worker.
      assert.equal(calls, literal.length + 1);
      assert.equal((source.match(/\brequire\(file\)/g) || []).length, 1);
      const used = new Set([...source.matchAll(/\bfs\.(\w+)/g)].map(match => match[1]));
      assert.deepEqual([...used].sort(), ['closeSync', 'fstatSync', 'lstatSync', 'openSync', 'readSync', 'realpathSync']);
      assert.match(source, /fs\.openSync\(file, 'r'\)/);
      assert.match(source, /resourceLimits/);
    } else {
      assert.equal(calls, literal.length, 'nonliteral require');
      assert(!/\bfs\b|\bprocess\b|\bglobalThis\b/.test(source));
    }
    for (const name of literal) if (name.startsWith('./')) inspectRuntime(require.resolve(path.resolve(path.dirname(file), name)));
  }
  inspectRuntime(extensionFile);
  assert.deepEqual([...closure].sort(), [extensionFile, modelFile, readerFile].sort());
  assert(!fs.existsSync(path.join(extensionRoot, 'fixtures', 'synthetic-work.json')));
  pass('runtime closure: extension, pure model and reader only; closed literal requires, one dynamic core require, read-only fs');

  // ── Locator ─────────────────────────────────────────────────────────────
  const absent = { FORGE_HOME: path.join(temp, 'absent-forge-home') };
  function sourceTree(name, { declare = true, coreFile: withCore = true, manifestBytes } = {}) {
    const base = path.join(temp, name);
    write(path.join(base, 'extensions/forge-vscode/package.json'), '{}\n');
    write(path.join(base, 'forge-source-manifest.json'), manifestBytes
      || JSON.stringify({ sources: declare ? [{ source_id: 'vscode-panel', inputs: ['extensions/forge-vscode'] }] : [{ source_id: 'agents', inputs: ['agents'] }] }));
    if (withCore) write(path.join(base, 'scripts/forge-panel-source.js'), 'module.exports = {};\n');
    return base;
  }
  function installation(home) {
    write(path.join(home, 'VERSION'), '4.46.8\n');
    write(path.join(home, 'manifest.json'), '{}\n');
    write(path.join(home, 'scripts/forge-panel-source.js'), 'module.exports = {};\n');
    return home;
  }
  const extensionIn = base => path.join(base, 'extensions', 'forge-vscode');
  const unavailable = { status: 'unavailable', reason: 'core-unavailable' };
  assert.deepEqual(reader.locateCore(), { status: 'ok', corePath: coreFile, origin: 'source-tree' });
  const accepted = sourceTree('tree-ok');
  assert.deepEqual(reader.locateCore({ extensionRoot: extensionIn(accepted), env: absent }),
    { status: 'ok', corePath: path.join(accepted, 'scripts', 'forge-panel-source.js'), origin: 'source-tree' });
  assert.deepEqual(reader.locateCore({ extensionRoot: extensionIn(sourceTree('tree-undeclared', { declare: false })), env: absent }), unavailable);
  assert.deepEqual(reader.locateCore({ extensionRoot: extensionIn(sourceTree('tree-no-core', { coreFile: false })), env: absent }), unavailable);
  const oversized = JSON.stringify({ sources: [{ source_id: 'vscode-panel', inputs: ['extensions/forge-vscode'] }] }) + ' '.repeat(reader.MANIFEST_LIMIT);
  assert.deepEqual(reader.locateCore({ extensionRoot: extensionIn(sourceTree('tree-oversized', { manifestBytes: oversized })), env: absent }), unavailable);
  assert.deepEqual(reader.locateCore({ extensionRoot: extensionIn(sourceTree('tree-bad-json', { manifestBytes: '{' })), env: absent }), unavailable);
  const outside = path.join(temp, 'outside', 'publisher.forge-vscode-0.1.0');
  fs.mkdirSync(outside, { recursive: true });
  const viaForgeHome = installation(path.join(temp, 'installed-forge-home'));
  assert.deepEqual(reader.locateCore({ extensionRoot: outside, env: { FORGE_HOME: viaForgeHome } }),
    { status: 'ok', corePath: path.join(viaForgeHome, 'scripts', 'forge-panel-source.js'), origin: 'installation' });
  const userHome = path.join(temp, 'installed-user-home');
  installation(path.join(userHome, '.forge-agent'));
  assert.deepEqual(reader.locateCore({ extensionRoot: outside, env: { HOME: userHome, USERPROFILE: userHome } }),
    { status: 'ok', corePath: path.join(userHome, '.forge-agent', 'scripts', 'forge-panel-source.js'), origin: 'installation' });
  const partial = path.join(temp, 'partial-forge-home');
  installation(partial);
  fs.unlinkSync(path.join(partial, 'VERSION'));
  assert.deepEqual(reader.locateCore({ extensionRoot: outside, env: { FORGE_HOME: partial } }), unavailable);
  assert.deepEqual(reader.locateCore({ extensionRoot: outside, env: absent }), unavailable);
  // Directory junctions exercise the no-link rule on Windows without symlink privileges.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const realScripts = path.join(temp, 'real-scripts');
  write(path.join(realScripts, 'forge-panel-source.js'), 'module.exports = {};\n');
  const linkedTree = sourceTree('tree-linked', { coreFile: false });
  fs.symlinkSync(realScripts, path.join(linkedTree, 'scripts'), linkType);
  assert.deepEqual(reader.locateCore({ extensionRoot: extensionIn(linkedTree), env: absent }), unavailable);
  const linkedHome = path.join(temp, 'linked-forge-home');
  installation(linkedHome);
  fs.rmSync(path.join(linkedHome, 'scripts'), { recursive: true });
  fs.symlinkSync(realScripts, path.join(linkedHome, 'scripts'), linkType);
  assert.deepEqual(reader.locateCore({ extensionRoot: outside, env: { FORGE_HOME: linkedHome } }), unavailable);
  const linkedRoot = path.join(temp, 'linked-root');
  fs.symlinkSync(accepted, linkedRoot, linkType);
  assert.deepEqual(reader.locateCore({ extensionRoot: extensionIn(linkedRoot), env: absent }), unavailable);
  const fileLinkTree = sourceTree('tree-file-link', { coreFile: false });
  fs.mkdirSync(path.join(fileLinkTree, 'scripts'));
  try {
    fs.symlinkSync(path.join(realScripts, 'forge-panel-source.js'), path.join(fileLinkTree, 'scripts', 'forge-panel-source.js'), 'file');
    assert.deepEqual(reader.locateCore({ extensionRoot: extensionIn(fileLinkTree), env: absent }), unavailable);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    console.log('SKIP S05/T02 file symlink refusal: EPERM creating a file symlink on this host; junctions above cover links');
  }
  const relative = 'relative-home';
  const homes = [path.join(temp, 'h1'), path.join(temp, 'h2')];
  for (const env of [{}, { FORGE_HOME: homes[0] }, { FORGE_HOME: '  ', HOME: homes[0] }, { HOME: homes[0] }, { USERPROFILE: homes[1] },
    { HOME: homes[0], USERPROFILE: homes[1] }, { HOME: '', USERPROFILE: homes[1] }, { HOME: relative }, { FORGE_HOME: ` ${homes[1]} ` }]) {
    for (const platform of ['win32', 'darwin', 'linux', 'freebsd']) {
      assert.equal(reader.resolveForgeHome(env, platform), forgeHome.resolveForgeHome({ env, platform }), JSON.stringify({ env, platform }));
    }
  }
  pass('locator: own source tree or recognized installation only; undeclared, missing, oversized, linked and junction cores refused; forge-home parity');

  // ── Canonical data in temporary HOME, owner and project ─────────────────
  const work = scenario('work');
  bind(work);
  events(work);
  const proof = write(path.join(work.cwd, 'evidence/proof.md'), 'Original proof');
  assert.equal(personal.saveCheckpoint({ ...work, id: 'M001', intent: 'checkpoint', checkpoint: {
    nextAction: [{ source: proof, text: 'Conferir resultado' }], lastResult: [{ source: proof, text: 'Resultado parcial' }] } }).status, 'ok');
  const asked = questions.openQuestions({ cwd: work.cwd, unit: 'execute-task/T03', milestone: 'M001', decision_set: 'panel-fixture',
    questions: [{ id: 'choice', question: 'Qual alternativa?' }] });
  questions.answer({ cwd: work.cwd, identity: asked.identity_sha256, answers: [{ id: 'choice', answer: 'SECRET-ANSWER', source: 'user-text' }] });
  questions.openQuestions({ cwd: work.cwd, unit: 'execute-task/T03', milestone: 'M001', decision_set: 'pending-fixture',
    questions: [{ id: 'next-choice', question: 'Próxima decisão?' }] });
  // A core planted in the workspace must never be the one that runs.
  write(path.join(work.cwd, 'scripts/forge-panel-source.js'), "module.exports = { readPanelSource() { return { schema_version: 1, planted: true }; } };\n");
  write(path.join(work.cwd, 'forge-source-manifest.json'), JSON.stringify({ sources: [{ source_id: 'vscode-panel', inputs: ['extensions/forge-vscode'] }] }));
  const empty = scenario('empty');
  const missing = scenario('missing');
  fs.unlinkSync(bind(missing));
  const stale = scenario('stale');
  bind(stale);
  const capture = write(path.join(stale.cwd, 'proof.md'), 'proof');
  assert.equal(personal.saveCheckpoint({ ...stale, id: 'M001', intent: 'checkpoint', checkpoint: { nextAction: [{ text: 'Next', source: capture }] } }).status, 'ok');
  fs.appendFileSync(capture, 'changed');
  const invalid = scenario('invalid');
  write(path.join(invalid.userHome, '.forge-personal/context.json'), '{');
  const foreign = scenario('foreign');
  bind(foreign);
  const otherHome = path.join(temp, 'foreign-other-home');
  fs.mkdirSync(otherHome);
  bind({ ...foreign, userHome: otherHome, env: { ...foreign.env, HOME: otherHome, USERPROFILE: otherHome } }, 'M003');
  fs.mkdirSync(path.join(foreign.cwd, '.gsd/forge'), { recursive: true });
  questions.openQuestions({ cwd: foreign.cwd, unit: 'execute-task/T03', milestone: 'M003', decision_set: 'foreign',
    questions: [{ id: 'foreign', question: 'Private foreign question' }] });
  const ambiguous = scenario('ambiguous');
  bind(ambiguous);
  const second = path.join(temp, 'ambiguous-second');
  fs.mkdirSync(path.join(second, '.gsd'), { recursive: true });
  bind({ ...ambiguous, cwd: second, project: second }, 'M002');
  const fileFolder = dir => ({ uri: { scheme: 'file', fsPath: dir } });
  const virtualFolder = { uri: { scheme: 'vscode-vfs', fsPath: '/virtual/project' } };
  const cases = [
    ['work', work, [virtualFolder, fileFolder(work.cwd)], [work.cwd], dto => dto.state.reason === 'snapshot' && dto.agents.length > 0 && dto.pending.length > 0 && dto.evidence.length > 0],
    ['empty', empty, [fileFolder(empty.cwd)], [empty.cwd], dto => dto.state.status === 'empty' && dto.state.reason === 'no-bindings'],
    ['missing', missing, [fileFolder(missing.cwd)], [missing.cwd], dto => dto.state.status === 'ok' && dto.works[0].freshness === 'missing'],
    ['stale', stale, [fileFolder(stale.cwd)], [stale.cwd], dto => dto.state.status === 'ok' && dto.works[0].freshness === 'stale'],
    ['invalid', invalid, [fileFolder(invalid.cwd)], [invalid.cwd], dto => dto.state.status === 'invalid' && dto.state.reason === 'store-corrupt'],
    ['foreign', foreign, [fileFolder(foreign.cwd)], [foreign.cwd], dto => dto.state.status === 'ok' && dto.census.pending.foreign > 0
      && dto.works.every(row => row.id === 'M001') && !JSON.stringify(dto).includes('Private foreign')],
    ['ambiguous', ambiguous, [fileFolder(ambiguous.cwd), fileFolder(second)], [ambiguous.cwd, second], dto => dto.state.reason === 'workspace-ambiguous'],
  ];

  // ── Worker ──────────────────────────────────────────────────────────────
  const realReader = reader.createReader({ coreOptions: { userHome: work.userHome, env: work.env, now } });
  const fromWorker = await realReader.read([work.cwd], { trigger: 'manual' });
  realReader.dispose();
  assert.deepEqual(fromWorker, core.readPanelSource({ folders: [work.cwd], userHome: work.userHome, env: work.env, now }));
  assert.equal(fromWorker.state.reason, 'snapshot');
  function fakeCore(name, body) { return write(path.join(temp, name, 'forge-panel-source.js'), body); }
  async function readWith(corePath, options = {}) {
    const instance = reader.createReader({ locate: () => ({ status: 'ok', corePath, origin: 'source-tree' }), ...options });
    try { return await instance.read([work.cwd], { trigger: 'manual' }); } finally { instance.dispose(); }
  }
  const slowStart = Date.now();
  const slow = await readWith(fakeCore('core-slow', 'module.exports = { readPanelSource() { const end = Date.now() + 60000; while (Date.now() < end); } };\n'), { timeoutMs: 300 });
  assert.deepEqual(slow, model.localResult('core-timeout'));
  assert(Date.now() - slowStart < 10000, 'timeout must terminate the busy worker');
  const secret = `SECRET ${temp}`;
  for (const body of [`module.exports = { readPanelSource() { throw new Error(${JSON.stringify(secret)}); } };\n`,
    `throw new Error(${JSON.stringify(secret)});\n`, 'module.exports = {};\n']) {
    const failed = await readWith(fakeCore(`core-throws-${sha256(body).slice(0, 8)}`, body));
    assert.deepEqual(failed, model.localResult('core-failed'));
    assert(!JSON.stringify(failed).includes('SECRET') && !JSON.stringify(failed).includes(temp));
  }
  for (const body of ['module.exports = { readPanelSource() { return { schema_version: 2, state: { status: "ok" } }; } };\n',
    'module.exports = { readPanelSource() { return { schema_version: 1, planted: true }; } };\n', 'module.exports = { readPanelSource() { return null; } };\n']) {
    assert.deepEqual(await readWith(fakeCore(`core-malformed-${sha256(body).slice(0, 8)}`, body)), model.localResult('dto-invalid'));
  }
  const renamed = write(path.join(temp, 'core-renamed', 'other-name.js'), 'module.exports = { readPanelSource() { return null; } };\n');
  assert.deepEqual(await readWith(renamed), model.localResult('core-failed'));
  for (const locate of [() => ({ status: 'unavailable', reason: 'core-unavailable' }), () => { throw new Error(secret); }, () => null]) {
    const instance = reader.createReader({ locate, WorkerImpl: FakeWorker });
    FakeWorker.created.length = 0;
    assert.deepEqual(await instance.read([work.cwd], { trigger: 'manual' }), model.localResult('core-unavailable'));
    assert.equal(FakeWorker.created.length, 0);
    instance.dispose();
  }
  pass('worker: real canonical DTO, slow core terminated as core-timeout, thrown errors as core-failed without text, malformed as dto-invalid');

  const locate = () => ({ status: 'ok', corePath: coreFile, origin: 'source-tree' });
  const dtoA = core.readPanelSource({ folders: [], now });
  const dtoB = core.readPanelSource({ folders: [], now: now + 1000 });
  FakeWorker.created.length = 0;
  const coalescing = reader.createReader({ locate, WorkerImpl: FakeWorker, minIntervalMs: 0 });
  const first = coalescing.read(['a'], { trigger: 'manual' });
  assert.equal(FakeWorker.created.length, 1);
  const [worker] = FakeWorker.created;
  assert.equal(worker.file, readerFile);
  assert.deepEqual(worker.options.resourceLimits, { maxOldGenerationSizeMb: 256 });
  assert.equal(worker.options.workerData.forgePanelCore, coreFile);
  assert.deepEqual(worker.options.workerData.folders, ['a']);
  const followers = ['b', 'c', 'd', 'e', 'f'].map((folder, index) => coalescing.read([folder], { trigger: index % 2 ? 'manual' : 'visible' }));
  assert.equal(FakeWorker.created.length, 1, 'one read at a time');
  worker.reply(dtoA);
  assert.deepEqual(await first, dtoA);
  assert.equal(worker.terminated, 1);
  assert.equal(FakeWorker.created.length, 2, 'five requests coalesce into one following read');
  assert.deepEqual(FakeWorker.created[1].options.workerData.folders, ['f']);
  FakeWorker.created[1].reply(dtoB);
  for (const result of await Promise.all(followers)) assert.deepEqual(result, dtoB);
  assert.equal(FakeWorker.created.length, 2);
  coalescing.dispose();

  const originalSchedulingNow = Date.now;
  let schedulingNow = 1000;
  Date.now = () => schedulingNow;
  try {
  AutoWorker.dto = dtoA;
  FakeWorker.created.length = 0;
  const throttled = reader.createReader({ locate, WorkerImpl: AutoWorker, minIntervalMs: 200 });
  const started = Date.now();
  await throttled.read(['a'], { trigger: 'activation' });
  const visible = throttled.read(['a'], { trigger: 'visible' });
  const focus = throttled.read(['a'], { trigger: 'focus' });
  assert.equal(visible, focus, 'automatic triggers inside the interval share one scheduled read');
  assert.equal(FakeWorker.created.length, 1);
  schedulingNow += 200;
  await visible;
  assert.equal(FakeWorker.created.length, 2);
  assert(Date.now() - started >= 150, 'automatic read waited for the minimum interval');
  // Scheduling is proved by synchronous worker creation, not a wall-clock bound.
  const manual = throttled.read(['a'], { trigger: 'manual' });
  assert.equal(FakeWorker.created.length, 3, 'manual refresh bypasses the interval and creates its worker immediately');
  await manual;
  assert.equal(FakeWorker.created.length, 3);
  throttled.dispose();

  // An automatic trigger at the same point is deferred until the interval timer.
  FakeWorker.created.length = 0;
  const deferred = reader.createReader({ locate, WorkerImpl: AutoWorker, minIntervalMs: 200 });
  await deferred.read(['a'], { trigger: 'activation' });
  assert.equal(FakeWorker.created.length, 1);
  const automatic = deferred.read(['a'], { trigger: 'visible' });
  assert.equal(FakeWorker.created.length, 1, 'automatic read inside the interval does not create a worker synchronously');
  schedulingNow += 200;
  await automatic;
  assert.equal(FakeWorker.created.length, 2);
  deferred.dispose();

  } finally { Date.now = originalSchedulingNow; }

  // A manual request during an in-flight read joins the queue, never a concurrent worker.
  FakeWorker.created.length = 0;
  const serial = reader.createReader({ locate, WorkerImpl: FakeWorker, minIntervalMs: 200 });
  const running = serial.read(['a'], { trigger: 'manual' });
  assert.equal(FakeWorker.created.length, 1);
  const joined = serial.read(['b'], { trigger: 'manual' });
  assert.equal(FakeWorker.created.length, 1, 'manual refresh while a read is in flight creates no second worker');
  FakeWorker.created[0].reply(dtoA);
  assert.deepEqual(await running, dtoA);
  assert.equal(FakeWorker.created.length, 2);
  FakeWorker.created[1].reply(dtoB);
  assert.deepEqual(await joined, dtoB);
  assert.equal(FakeWorker.created.length, 2);
  serial.dispose();

  FakeWorker.created.length = 0;
  const disposable = reader.createReader({ locate, WorkerImpl: FakeWorker });
  const inFlight = disposable.read(['a'], { trigger: 'manual' });
  const queued = disposable.read(['b'], { trigger: 'manual' });
  disposable.dispose();
  disposable.dispose();
  assert.equal(FakeWorker.created[0].terminated, 1);
  assert.equal(await inFlight, null);
  assert.equal(await queued, null);
  assert.equal(await disposable.read(['c'], { trigger: 'manual' }), null);
  assert.equal(FakeWorker.created.length, 1);
  pass('worker scheduling: one read at a time, five requests coalesce, 2000 ms-style interval for automatic triggers, dispose terminates once');

  // ── Pure model ──────────────────────────────────────────────────────────
  const directDtos = Object.fromEntries(cases.map(([name, options, , folders]) => [name,
    core.readPanelSource({ folders, userHome: options.userHome, env: options.env, now })]));
  for (const [name, , , , expected] of cases) assert(expected(directDtos[name]), `${name}: ${JSON.stringify(directDtos[name].state)}`);
  for (const [name, dto] of Object.entries(directDtos)) {
    const before = JSON.stringify(dto);
    const nodes = model.buildNodes(dto);
    assert(Object.isFrozen(nodes));
    assert.deepEqual(model.buildNodes(dto), nodes);
    assert.equal(JSON.stringify(dto), before, `${name}: model mutated the DTO`);
    const items = direct(nodes);
    assert.equal(new Set(ids(items)).size, ids(items).length, `${name}: duplicate ids`);
    for (const value of texts(items)) {
      assert(typeof value === 'string' && !value.includes(temp) && !value.includes('SECRET-ANSWER') && !value.includes('Private foreign'), `${name}: ${value}`);
    }
    if (dto.state.status === 'ok') {
      assert.deepEqual(items.map(item => item.label).slice(0, 4), ['Trabalho', 'Agentes', 'Pendências', 'Evidências']);
      assert.match(items[4].label, /^Lido às \d{2}:\d{2}:\d{2}$/);
      assert.match(items[4].description, /somente leitura/);
      assert.deepEqual(items[0].children.slice(0, dto.works.length).map(item => item.label), dto.works.map(row => row.id));
    } else {
      assert.equal(items.length, 1);
      assert.equal(items[0].label, dto.state.label);
    }
  }
  const workItems = direct(model.buildNodes(directDtos.work));
  const agentLabels = workItems[1].children.map(item => item.label);
  directDtos.work.agents.forEach((agent, index) => assert(agentLabels[index].startsWith(agent.kind_label)));
  assert(workItems[1].children.some(item => item.children.some(child => child.label.startsWith('Modelo resolvido:'))));
  assert(workItems[1].children.some(item => item.children.some(child => child.label === `Fase: ${directDtos.work.agents[0].phase.label}`)));
  assert(workItems[2].children.some(item => item.label === 'next-choice: Próxima decisão?'));
  assert(workItems[3].children.some(item => item.label === 'Resultado parcial' && item.description.startsWith('evidence/proof.md · no projeto · validade atual')));
  assert.match(direct(model.buildNodes(directDtos.stale))[0].children[0].description, new RegExp(`dados ${directDtos.stale.works[0].freshness_label}`));
  assert.match(direct(model.buildNodes(directDtos.missing))[0].children[0].description, new RegExp(`dados ${directDtos.missing.works[0].freshness_label}`));
  assert(direct(model.buildNodes(directDtos.foreign))[2].children.some(item => /de outro escopo, só contagem/.test(item.label)));
  for (const [reason, state] of Object.entries(model.LOCAL_STATES)) {
    const result = model.localResult(reason);
    const items = direct(model.buildNodes(result));
    assert.deepEqual(items.map(item => item.label), [state.label]);
    assert.deepEqual(model.summarize(result), { status: state.status, reason, counts: { works: 0, agents: 0, pending: 0, evidence: 0 }, stable_sha256: null, generated_at: null });
  }
  assert.deepEqual(Object.keys(model.LOCAL_STATES).sort(), ['core-failed', 'core-timeout', 'core-unavailable', 'dto-invalid', 'no-workspace', 'workspace-not-local']);
  for (const value of [undefined, null, 1, 'x', [], {}, { ...directDtos.work, schema_version: 2 }, { ...directDtos.work, state: null },
    { ...directDtos.work, works: 'x' }, { ...directDtos.work, stable_sha256: 'short' }, { ...directDtos.work, generated_at: 'never' },
    { local: true, state: { status: 'ok', reason: 'invented' } }]) {
    assert.deepEqual(direct(model.buildNodes(value)).map(item => item.label), [model.LOCAL_STATES['dto-invalid'].label]);
  }
  const hostile = { ...directDtos.work, works: [null, 7, {}], agents: [{ model: 5, activity: { local: [1] }, navigation: 'x' }], pending: [{}], evidence: [{ path: 3 }] };
  assert.equal(direct(model.buildNodes(hostile)).length, 5);
  assert.deepEqual(direct(model.readingNodes()).map(item => item.label), [model.READING_LABEL]);
  for (const forged of [{ label: 'x', command: { command: 'workbench.action.terminal.new' }, contextValue: 'mutable', children: [1] },
    Object.create(null), null, 'element', 5]) {
    const item = model.getTreeItem(forged);
    assert.deepEqual(item, { label: '', collapsibleState: 0 });
    assert(Object.isFrozen(item));
    assert.equal(model.getChildren(model.buildNodes(directDtos.work), forged === null ? {} : forged).length, 0);
  }
  pass('model: frozen unique pt-BR nodes from DTO labels for work, empty, missing, stale, invalid, foreign and ambiguous plus every local state');

  // ── Activation with vscode stub and traps ───────────────────────────────
  const trapCalls = [];
  const trap = name => function trapped() { trapCalls.push(name); throw new Error(`prohibited: ${name}`); };
  let host;
  function hostEvent(name) {
    const listeners = [];
    const event = listener => {
      listeners.push(listener);
      const item = { name, disposed: 0, dispose() { item.disposed += 1; } };
      host.disposables.push(item);
      return item;
    };
    event.fire = value => listeners.slice().forEach(listener => listener(value));
    return event;
  }
  function resetHost(folders) {
    host = { folders, treeViews: [], commands: [], disposables: [], emitters: [] };
    host.windowState = hostEvent('window-state');
    host.workspaceFolders = hostEvent('workspace-folders');
  }
  class StubEmitter {
    constructor() {
      const listeners = [];
      this.disposed = 0;
      this.fired = 0;
      this.event = listener => { listeners.push(listener); return { dispose() {} }; };
      this.fire = value => { this.fired += 1; listeners.forEach(listener => listener(value)); };
      host.emitters.push(this);
    }
    dispose() { this.disposed += 1; }
  }
  const stub = Object.freeze({
    EventEmitter: StubEmitter,
    window: Object.freeze({
      createTreeView(id, options) {
        const view = { id, options, visible: false, disposed: 0, onDidChangeVisibility: hostEvent('tree-visibility'), dispose() { view.disposed += 1; } };
        host.treeViews.push(view);
        return view;
      },
      onDidChangeWindowState: listener => host.windowState(listener),
      createWebviewPanel: trap('window.createWebviewPanel'), registerWebviewViewProvider: trap('window.registerWebviewViewProvider'),
      createTerminal: trap('window.createTerminal'), showInputBox: trap('window.showInputBox'), showQuickPick: trap('window.showQuickPick'),
      showOpenDialog: trap('window.showOpenDialog'), showSaveDialog: trap('window.showSaveDialog'), showTextDocument: trap('window.showTextDocument'),
      registerTreeDataProvider: trap('window.registerTreeDataProvider'), createStatusBarItem: trap('window.createStatusBarItem'),
    }),
    commands: Object.freeze({
      registerCommand(id, handler) {
        if (id !== 'forge.work.refresh') return trap(`commands.registerCommand:${id}`)();
        const item = { name: 'command', disposed: 0, dispose() { item.disposed += 1; } };
        host.disposables.push(item);
        host.commands.push({ id, handler });
        return item;
      },
      executeCommand: trap('commands.executeCommand'),
    }),
    env: Object.freeze({ openExternal: trap('env.openExternal'), clipboard: Object.freeze({ readText: trap('env.clipboard.readText'), writeText: trap('env.clipboard.writeText') }) }),
    workspace: Object.freeze({
      get workspaceFolders() { return host.folders; },
      onDidChangeWorkspaceFolders: listener => host.workspaceFolders(listener),
      fs: Object.freeze(Object.fromEntries(['readFile', 'writeFile', 'delete', 'rename', 'copy', 'createDirectory', 'readDirectory', 'stat'].map(name => [name, trap(`workspace.fs.${name}`)]))),
      applyEdit: trap('workspace.applyEdit'), createFileSystemWatcher: trap('workspace.createFileSystemWatcher'),
      openTextDocument: trap('workspace.openTextDocument'), findFiles: trap('workspace.findFiles'), getConfiguration: trap('workspace.getConfiguration'),
    }),
    tasks: Object.freeze({ executeTask: trap('tasks.executeTask'), registerTaskProvider: trap('tasks.registerTaskProvider') }),
    debug: Object.freeze({ startDebugging: trap('debug.startDebugging') }),
  });
  let workerCount = 0;
  class CountingWorker extends workerThreads.Worker {
    constructor(file, options) {
      assert.equal(file, readerFile);
      assert.deepEqual(options.resourceLimits, { maxOldGenerationSizeMb: 256 });
      assert.equal(options.workerData.forgePanelCore, coreFile);
      assert.equal(options.workerData.coreOptions, undefined, 'extension never passes core options');
      super(file, options);
      workerCount += 1;
    }
  }
  const countingThreads = Object.freeze({ ...workerThreads, Worker: CountingWorker });
  const originalLoad = Module._load;
  const observedImports = [];
  delete require.cache[extensionFile];
  delete require.cache[readerFile];
  let extension;
  Module._load = function load(name, parent, isMain) {
    if (parent && [extensionFile, readerFile, modelFile].includes(parent.filename)) {
      observedImports.push(name);
      assert(allowedImports[parent.filename].includes(name), name);
      if (name === 'vscode') return stub;
      if (name === 'node:worker_threads') return countingThreads;
    }
    return originalLoad.call(this, name, parent, isMain);
  };
  try { extension = require(extensionFile); } finally { Module._load = originalLoad; }
  assert.deepEqual(observedImports.sort(), [...allowedImports[extensionFile], ...allowedImports[readerFile]].sort());
  assert.equal(typeof extension.deactivate, 'function');
  extension.deactivate();
  function setEnv(options) { for (const key of ENV_KEYS) process.env[key] = options.env[key]; }
  function assertDisposedOnce() {
    assert.equal(host.treeViews.length, 1);
    assert.equal(host.treeViews[0].disposed, 1);
    assert.equal(host.emitters.length, 1);
    assert.equal(host.emitters[0].disposed, 1);
    assert.deepEqual(host.disposables.map(item => item.name).sort(), ['command', 'tree-visibility', 'window-state', 'workspace-folders']);
    for (const item of host.disposables) assert.equal(item.disposed, 1, item.name);
  }

  const before = tree(temp);
  const restore = [];
  function fsTrap(key) {
    if (typeof fs[key] !== 'function') return;
    const original = fs[key];
    fs[key] = () => { throw new Error(`mutated ${key}`); };
    restore.push(() => { fs[key] = original; });
  }
  for (const key of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'link', 'symlink', 'truncate', 'utimes', 'chmod']) {
    for (const suffix of ['', 'Sync']) fsTrap(key + suffix);
  }
  for (const key of ['openSync', 'open']) {
    const original = fs[key];
    fs[key] = (file, flags, ...args) => { assert(flags === undefined || flags === 'r' || flags === 0, 'write-open'); return original(file, flags, ...args); };
    restore.push(() => { fs[key] = original; });
  }
  const observations = [];
  try {
    for (const [name, options, folders, readFolders] of cases) {
      setEnv(options);
      resetHost(folders);
      const subscriptions = [];
      const api = extension.activate({ subscriptions });
      assert(Object.isFrozen(api) && Object.isFrozen(api.provider));
      assert.deepEqual(Object.keys(api).sort(), ['provider', 'refresh', 'state', 'treeView']);
      assert.deepEqual(Object.keys(api.provider).sort(), ['getChildren', 'getTreeItem', 'onDidChangeTreeData']);
      assert.equal(api.treeView, host.treeViews[0]);
      assert.equal(host.treeViews[0].id, 'forge.work');
      assert.equal(host.treeViews[0].options.treeDataProvider, api.provider);
      assert.equal(host.treeViews[0].options.canSelectMany, false);
      assert.deepEqual(host.commands.map(item => item.id), ['forge.work.refresh']);
      assert.deepEqual(api.state(), { status: 'pending', reason: 'reading', counts: { works: 0, agents: 0, pending: 0, evidence: 0 }, stable_sha256: null, generated_at: null });
      assert.deepEqual(render(api.provider).map(item => item.label), [model.READING_LABEL]);
      const refreshed = api.refresh();
      assert(refreshed instanceof Promise);
      assert.equal(await refreshed, undefined);
      if (name === 'work') {
        // Right after a read starts the 2000 ms interval: automatic triggers wait, the command does not.
        const base = workerCount;
        const view = host.treeViews[0];
        host.windowState.fire({ focused: true });
        host.windowState.fire({ focused: false });
        assert.equal(workerCount, base, 'focus without a visible view does not read');
        view.visible = true;
        view.onDidChangeVisibility.fire({ visible: true });
        host.windowState.fire({ focused: true });
        host.workspaceFolders.fire({ added: [], removed: [] });
        assert.equal(workerCount, base, 'automatic triggers inside the minimum interval are scheduled, not started');
        await host.commands[0].handler();
        assert.equal(workerCount, base + 1, 'visibility, focus, folders and command deduplicate into one read');
        await delay(2300);
        assert.equal(workerCount, base + 1, 'no polling and no second scheduled read');
      }
      const state = api.state();
      assert(Object.isFrozen(state));
      const instant = Date.parse(state.generated_at);
      assert(Number.isFinite(instant));
      const canonical = core.readPanelSource({ folders: readFolders, userHome: options.userHome, env: options.env, now: instant });
      assert.deepEqual(state, model.summarize(canonical), name);
      assert.equal(state.stable_sha256, canonical.stable_sha256);
      const shown = render(api.provider);
      assert.deepEqual(shown, direct(model.buildNodes(canonical)), `${name}: rendered nodes equal readPanelSource for the same data`);
      for (const forged of [{ label: 'forged', command: { command: 'forge.work.refresh' }, contextValue: 'x', children: [] }, {}, null]) {
        assert.deepEqual(api.provider.getTreeItem(forged), { label: '', collapsibleState: 0 });
        assert.deepEqual(api.provider.getChildren(forged || {}), []);
      }
      assert(host.emitters[0].fired >= 1);
      observations.push([name, state.status, state.reason]);
      subscriptions[0].dispose();
      assertDisposedOnce();
      extension.deactivate();
      subscriptions[0].dispose();
      assertDisposedOnce();
    }
    for (const [folders, reason] of [[[virtualFolder], 'workspace-not-local'], [[], 'no-workspace'], [undefined, 'no-workspace']]) {
      resetHost(folders);
      const base = workerCount;
      const subscriptions = [];
      const api = extension.activate({ subscriptions });
      assert.equal(api.state().reason, reason);
      await api.refresh();
      assert.deepEqual(api.state(), model.summarize(model.localResult(reason)));
      assert.deepEqual(render(api.provider).map(item => item.label), [model.LOCAL_STATES[reason].label]);
      assert.equal(workerCount, base, `${reason}: no read`);
      extension.deactivate();
      assertDisposedOnce();
      subscriptions[0].dispose();
      assertDisposedOnce();
    }
  } finally {
    restore.reverse().forEach(fn => fn());
    restoreEnv();
  }
  assert.deepEqual(tree(temp), before, 'HOME, owner and project bytes, mtime and listings unchanged');
  assert.deepEqual(trapCalls, []);
  assert.deepEqual(observations.map(([name, status, reason]) => `${name}:${status}:${reason}`), [
    'work:ok:snapshot', 'empty:empty:no-bindings', 'missing:ok:snapshot', 'stale:ok:snapshot',
    'invalid:invalid:store-corrupt', 'foreign:ok:snapshot', 'ambiguous:empty:workspace-ambiguous']);
  pass('activation: one TreeView and command, nodes and stable_sha256 equal readPanelSource per case, triggers deduplicated, non-file and empty folders unread');
  pass('read-only flow: bytes, mtime and listings of HOME, owner and project unchanged; every trap intact; disposal exactly once');

  // ── Inventory and catalog ───────────────────────────────────────────────
  const sourceManifest = inventory.load(root);
  const panelSource = sourceManifest.sources.find(source => source.source_id === 'vscode-panel');
  assert.deepEqual(panelSource, {
    source_id: 'vscode-panel', owner: 'integration', inputs: ['extensions/forge-vscode'],
    render_targets: [{ path: 'extensions/forge-vscode', recursive: true }],
    capability: 'integration-vscode-panel', security_role: 'operator', newline: 'lf',
    origin_header: 'Generated by Forge source manifest', common: { format: 'vscode-extension' },
    conditional: { claude: { status: 'unavailable' }, codex: { status: 'conditional' } },
  });
  assert.equal(inventory.audit(sourceManifest).ok, true);
  const withoutPanel = { ...sourceManifest, sources: sourceManifest.sources.filter(source => source !== panelSource) };
  const renderOptions = { ...codex.PRODUCTION_DISPATCH_DIALECT, repo: root, projectRoot: root, forgeHome: path.join(root, 'unused-forge-home'),
    codexHome: path.join(root, 'unused-codex-home'), claudeHome: path.join(root, 'unused-claude-home') };
  const codexReport = codex.render({ ...renderOptions, manifest: sourceManifest });
  const claudeReport = claude.render({ ...renderOptions, manifest: sourceManifest });
  for (const report of [codexReport, claudeReport]) {
    assert(!report.artifacts.some(artifact => artifact.source_id === 'vscode-panel' || artifact.source.startsWith('extensions/forge-vscode')));
  }
  const reportArtifact = codexReport.artifacts.find(artifact => artifact.source_id === 'codex-capabilities');
  assert(reportArtifact);
  assert.deepEqual(JSON.parse(reportArtifact.content).surfaces.find(source => source.source_id === 'vscode-panel'), { source_id: 'vscode-panel', status: 'conditional' });
  assert.deepEqual(claudeReport.artifacts, claude.render({ ...renderOptions, manifest: withoutPanel }).artifacts);
  assert.deepEqual(codexReport.artifacts.filter(artifact => artifact.source_id !== 'codex-capabilities'),
    codex.render({ ...renderOptions, manifest: withoutPanel }).artifacts.filter(artifact => artifact.source_id !== 'codex-capabilities'));
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'forge-capabilities.json'), 'utf8'));
  const catalogIds = catalog.capabilities.map(entry => entry.capability_id);
  assert.equal(catalogIds.indexOf('integration-vscode-panel'), catalogIds.indexOf('integration-claude-settings') + 1);
  assert.deepEqual(catalog.capabilities.find(entry => entry.capability_id === 'integration-vscode-panel'), {
    capability_id: 'integration-vscode-panel', kind: 'app', owner: 'integration', required: false, classification: 'conditional',
    hosts: { claude: 'unavailable', codex: 'conditional' }, platforms: { macos: 'conditional', windows: 'conditional', linux: 'conditional' },
    probe: { kind: 'filesystem', path: 'extensions/forge-vscode/package.json' },
  });
  assert.deepEqual(capabilities.audit(root).issues, []);
  pass('inventory: Codex conditional, Claude unavailable, panel unprojected, Codex report conditional, Claude bytes unchanged, catalog entry exact');

  // ── README and discovery ────────────────────────────────────────────────
  const readme = fs.readFileSync(path.join(extensionRoot, 'README.md'), 'utf8');
  for (const pattern of [/somente leitura/, /forge-panel-source\.js/, /readPanelSource/, /Trabalho/, /Agentes/, /Pendências/, /Evidências/,
    /no-workspace/, /workspace-not-local/, /core-unavailable/, /core-timeout/, /core-failed/, /dto-invalid/,
    /Sem rede, listener, servidor, webview, hosting ou marketplace/, /Sem ações/, /FORGE_HOME/, /junction/,
    /--extensionDevelopmentPath/, /instalação persistente no perfil do operador é uma etapa pendente/,
    /aceite visual e de compreensão permanece pendente/, /Prova\s+offline e prova runtime são distintas/]) {
    assert.match(readme, pattern);
  }
  // A development command is only documented as profile-safe when it isolates user data and extensions.
  const devCommands = readme.split('\n').filter(line => /^\s*code\b.*--extensionDevelopmentPath/.test(line));
  assert(devCommands.length >= 1);
  for (const line of devCommands) {
    for (const flag of [/--user-data-dir=\S*temp\S*/, /--extensions-dir=\S*temp\S*/, /--disable-extensions\b/]) assert.match(line, flag);
  }
  const bare = 'code --extensionDevelopmentPath=<checkout>/extensions/forge-vscode <projeto>';
  assert(!devCommands.some(line => line.trim() === bare), 'bare development command must not return');
  assert(!/não\s+grava nada no perfil/.test(readme) || devCommands.every(line => /--user-data-dir/.test(line) && /--extensions-dir/.test(line)));
  // The only mention of synthetic data is its explicit absence.
  assert.equal((readme.match(/sintétic/g) || []).length, 1);
  assert.match(readme, /Não há dados sintéticos/);
  pass('documentation: sources, explicit states, read-only guarantees, trusted core, local use, pending install and UAT, offline proof only');

  const discovery = spawnSync(process.execPath, ['scripts/run-tests.js', '--list', '--match', 'vscode-panel'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.equal(discovery.stdout.trim(), 'forge-vscode-panel.test.js');
  pass('discovery: canonical runner lists forge-vscode-panel.test.js');
})().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}).finally(() => {
  restoreEnv();
  fs.rmSync(temp, { recursive: true, force: true });
});
