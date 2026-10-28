#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const inventory = require('./forge-source-manifest');
const codex = require('./forge-codex-renderer');
const claude = require('./forge-claude-renderer');

const root = path.resolve(__dirname, '..');
const extensionRoot = path.join(root, 'extensions', 'forge-vscode');
const extensionFile = path.join(extensionRoot, 'extension.js');
const modelFile = path.join(extensionRoot, 'forge-panel-model.js');
const fixtureFile = path.join(extensionRoot, 'fixtures', 'synthetic-work.json');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
const model = require(modelFile);
function pass(name) { console.log(`PASS C05 ${name}`); }

assert.equal(manifest.private, true);
assert.equal(manifest.name, 'forge-vscode');
assert.equal(manifest.publisher, 'forge-agent');
assert.equal(manifest.displayName, 'Forge');
assert.equal(manifest.version, '0.0.1');
assert.equal(manifest.engines.vscode, '^1.90.0');
assert.equal(manifest.main, './extension.js');
assert.equal(path.resolve(extensionRoot, manifest.main), extensionFile);
assert.deepEqual(manifest.activationEvents, ['onView:forge.work']);
assert.deepEqual(Object.keys(manifest.contributes).sort(), ['views', 'viewsContainers']);
assert.deepEqual(manifest.contributes.viewsContainers, {
  activitybar: [{ id: 'forge', title: 'Forge', icon: 'media/forge.svg' }],
});
assert.deepEqual(manifest.contributes.views, { forge: [{ id: 'forge.work', name: 'Trabalho (sintético)' }] });
assert.deepEqual(manifest.capabilities, { untrustedWorkspaces: { supported: true }, virtualWorkspaces: true });
for (const key of ['dependencies', 'devDependencies', 'scripts', 'extensionDependencies', 'commands', 'menus', 'configuration', 'webview', 'webviews']) {
  assert(!Object.hasOwn(manifest, key), key);
  assert(!Object.hasOwn(manifest.contributes, key), key);
}
const icon = fs.readFileSync(path.join(extensionRoot, manifest.contributes.viewsContainers.activitybar[0].icon), 'utf8');
assert.match(icon, /<svg\b/);
assert(!/script|href|onload|foreignObject/i.test(icon));
pass('package: private dependency-free view-only activation, main and local icon');

assert.equal(fixture.synthetic, true);
assert.deepEqual(Object.keys(fixture).sort(), ['agents', 'evidence', 'pending', 'phase', 'synthetic']);
assert.deepEqual(fixture.agents.map(agent => agent.type), ['nativo', 'sidecar']);
const fixtureText = JSON.stringify(fixture);
for (const pattern of [/[A-Za-z]:/, /(?:^|["\s])\//, /\\/, /@/, /\b(?:user(?:name)?|usu[aá]rio|email|token|secret|password|api[_-]?key)\b/i, /\bM(?:\d{3}|-\d{8})/, /\b(?:S|T)\d{2}\b/, /[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}/i]) {
  assert(!pattern.test(fixtureText), String(pattern));
}
assert.equal(fixture.pending[0].id, 'pergunta-exemplo');
assert.equal(fixture.evidence[0].link, 'docs/prova-inventada.md');
pass('fixture: explicitly synthetic invented data without personal paths secrets or real work IDs');

const originalFixture = JSON.stringify(fixture);
const nodes = model.buildNodes(fixture);
assert.deepEqual(nodes.map(node => node.label), ['Fase', 'Agentes', 'Pendências', 'Evidências']);
assert(nodes[0].description.startsWith(fixture.phase));
assert.deepEqual(nodes[1].children.map(node => node.label), fixture.agents.map(agent => agent.name));
fixture.agents.forEach((agent, index) => assert(nodes[1].children[index].description.startsWith(agent.type)));
assert.equal(nodes[2].children[0].label, `${fixture.pending[0].id}: ${fixture.pending[0].text}`);
assert.equal(nodes[3].children[0].label, fixture.evidence[0].label);
assert(nodes[3].children[0].description.startsWith(fixture.evidence[0].link));
function assertNodes(items) {
  assert(Object.isFrozen(items));
  for (const node of items) {
    assert(Object.isFrozen(node));
    const item = model.getTreeItem(node);
    assert(Object.isFrozen(item));
    assert.equal(item.label, node.label);
    assert.equal(item.description, node.description);
    assert.equal(item.tooltip, node.tooltip);
    assert.match(item.description, /Dados sintéticos/);
    assert.equal(item.collapsibleState, node.children.length ? 1 : 0);
    assert(!Object.hasOwn(item, 'command'));
    assert.equal(model.getChildren(items, node), node.children);
    assertNodes(node.children);
  }
}
assertNodes(nodes);
assert.equal(JSON.stringify(fixture), originalFixture);
assert.deepEqual(model.buildNodes(fixture), nodes);
assert.equal(model.getChildren(nodes), nodes);
pass('model: pure immutable pt-BR phase agents pending IDs and relative evidence nodes');

const empty = { synthetic: true, phase: '', agents: [], pending: [], evidence: [] };
for (const snapshot of [undefined, null, empty]) {
  assert.deepEqual(model.buildNodes(snapshot).map(node => node.label), ['Sem dados sintéticos']);
}
const invalid = [false, 1, '', [], {}, { ...fixture, synthetic: false }, { ...fixture, phase: null },
  { ...fixture, agents: null }, { ...fixture, agents: [null] },
  { ...fixture, agents: [{ name: 'Alfa', type: 'inventado' }] }, { ...fixture, pending: [{}] },
  { ...fixture, evidence: [{}] }];
for (const link of ['/absolute', 'C:/absolute', '../escape', 'docs/../escape', 'docs\\escape', 'https://example.test', 'docs/prova?query', 'docs/prova#fragment']) {
  invalid.push({ ...fixture, evidence: [{ label: 'Exemplo', link }] });
}
for (const snapshot of invalid) {
  const state = model.buildNodes(snapshot);
  assert.deepEqual(state.map(node => node.label), ['Snapshot sintético inválido']);
  assertNodes(state);
}
pass('model states: empty and invalid snapshots are explicit, unsafe evidence links refused without exceptions');

// Walk every literal local require from main, including the packaged JSON.
const closure = new Set();
const allowedImports = ['vscode', './forge-panel-model', './fixtures/synthetic-work.json'];
const prohibited = /\b(?:createServer|listen|createWebviewPanel|registerWebviewViewProvider|registerCommand|openExternal|writeFile|applyEdit)\b/;
function inspectRuntime(file) {
  if (closure.has(file)) return;
  closure.add(file);
  assert(file.startsWith(extensionRoot + path.sep));
  const source = fs.readFileSync(file, 'utf8');
  assert(!prohibited.test(source), `prohibited API in ${path.basename(file)}`);
  if (file.endsWith('.json')) return;
  const calls = [...source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)];
  assert.equal((source.match(/\brequire\b/g) || []).length, calls.length, 'nonliteral require');
  assert(!/\b(?:import|eval|Function|process|globalThis|fetch|WebSocket)\b/.test(source));
  if (file === modelFile) assert.equal(calls.length, 0, 'pure model imports a module');
  for (const [, , name] of calls) {
    assert(allowedImports.includes(name), `unapproved import ${name}`);
    if (name !== 'vscode') inspectRuntime(require.resolve(path.resolve(path.dirname(file), name)));
  }
}
inspectRuntime(extensionFile);
assert.deepEqual([...closure].sort(), [extensionFile, modelFile, fixtureFile].sort());
pass('runtime closure: only vscode pure model and fixture, no filesystem process network listener or mutation APIs');

const trapCalls = [];
const forbidden = name => () => { trapCalls.push(name); throw new Error(`prohibited: ${name}`); };
const treeCalls = [];
let disposals = 0;
const treeView = { dispose() { disposals += 1; } };
const stub = Object.freeze({
  window: Object.freeze({
    createTreeView(id, options) { treeCalls.push({ id, options }); return treeView; },
    createWebviewPanel: forbidden('createWebviewPanel'),
    registerWebviewViewProvider: forbidden('registerWebviewViewProvider'),
  }),
  commands: Object.freeze({ registerCommand: forbidden('registerCommand') }),
  env: Object.freeze({ openExternal: forbidden('env.openExternal') }),
  workspace: Object.freeze({ fs: Object.freeze({ writeFile: forbidden('workspace.fs.writeFile') }), applyEdit: forbidden('workspace.applyEdit') }),
});
const originalLoad = Module._load;
const observedImports = [];
const subscriptions = [];
delete require.cache[extensionFile];
delete require.cache[modelFile];
try {
  Module._load = function load(name, parent, isMain) {
    if (parent && [extensionFile, modelFile].includes(parent.filename)) {
      observedImports.push(name);
      assert(allowedImports.includes(name), name);
      if (name === 'vscode') return stub;
    }
    return originalLoad.call(this, name, parent, isMain);
  };
  const extension = require(extensionFile);
  assert.equal(typeof extension.deactivate, 'function');
  extension.deactivate();
  const api = extension.activate({ subscriptions });
  assert(Object.isFrozen(api));
  assert(Object.isFrozen(api.provider));
  assert.deepEqual(Object.keys(api).sort(), ['provider', 'treeView']);
  assert.deepEqual(Object.keys(api.provider).sort(), ['getChildren', 'getTreeItem']);
  assert.equal(api.treeView, treeView);
  assert.equal(treeCalls.length, 1);
  assert.equal(treeCalls[0].id, 'forge.work');
  assert.equal(treeCalls[0].options.treeDataProvider, api.provider);
  assert.equal(treeCalls[0].options.canSelectMany, false);
  assert.deepEqual(api.provider.getChildren(), nodes);
  for (const node of api.provider.getChildren()) {
    assert.deepEqual(api.provider.getChildren(node), node.children);
    assert.deepEqual(api.provider.getTreeItem(node), model.getTreeItem(node));
    for (const child of node.children) {
      assert.deepEqual(api.provider.getChildren(child), []);
      assert.deepEqual(api.provider.getTreeItem(child), model.getTreeItem(child));
    }
  }
  assert.deepEqual(observedImports, allowedImports);
  assert.deepEqual(trapCalls, []);
  assert.equal(subscriptions.length, 1);
  assert.equal(typeof subscriptions[0].dispose, 'function');
  assert.equal(disposals, 0);
  pass('activation: exactly one forge.work TreeView, frozen read-only API and fixture-derived children via local model');
  extension.deactivate();
  assert.equal(disposals, 1);
  subscriptions[0].dispose();
  extension.deactivate();
  assert.equal(disposals, 1);
  assert.deepEqual(trapCalls, []);
  pass('lifecycle: context subscription and deactivate dispose the view exactly once, mutation traps untouched');
} finally {
  Module._load = originalLoad;
  delete require.cache[extensionFile];
  delete require.cache[modelFile];
}

const sourceManifest = inventory.load(root);
const panelSource = sourceManifest.sources.find(source => source.source_id === 'vscode-panel');
assert.deepEqual(panelSource, {
  source_id: 'vscode-panel', owner: 'integration', inputs: ['extensions/forge-vscode'],
  render_targets: [{ path: 'extensions/forge-vscode', recursive: true }],
  capability: 'integration-vscode-panel', security_role: 'operator', newline: 'lf',
  origin_header: 'Generated by Forge source manifest', common: { format: 'vscode-extension' },
  conditional: { claude: { status: 'unavailable' }, codex: { status: 'planned' } },
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
assert.deepEqual(JSON.parse(reportArtifact.content).surfaces.find(source => source.source_id === 'vscode-panel'), { source_id: 'vscode-panel', status: 'planned' });
assert.deepEqual(claudeReport.artifacts, claude.render({ ...renderOptions, manifest: withoutPanel }).artifacts);
assert.deepEqual(codexReport.artifacts.filter(artifact => artifact.source_id !== 'codex-capabilities'),
  codex.render({ ...renderOptions, manifest: withoutPanel }).artifacts.filter(artifact => artifact.source_id !== 'codex-capabilities'));
pass('inventory: planned Codex unavailable Claude panel stays unprojected, Codex report planned, Claude bytes unchanged');

const readme = fs.readFileSync(path.join(extensionRoot, 'README.md'), 'utf8');
for (const pattern of [/prova da S01/i, /somente\s+leitura/, /dados sintéticos/, /sem rede, listener, servidor, hosting/, /modo desenvolvimento/, /perfil real/, /nenhuma instalação/, /marketplace/, /S05/, /aceite visual/]) assert.match(readme, pattern);
pass('documentation: S01 read-only synthetic proof, isolated development only, no network hosting marketplace or real-profile install');

const discovery = spawnSync(process.execPath, ['scripts/run-tests.js', '--list', '--match', 'vscode-panel'], { cwd: root, encoding: 'utf8', timeout: 30000 });
assert.equal(discovery.status, 0, discovery.stderr);
assert.equal(discovery.stdout.trim(), 'forge-vscode-panel.test.js');
pass('discovery: canonical runner lists forge-vscode-panel.test.js');
