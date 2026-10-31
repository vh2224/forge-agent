#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const probe = require('./forge-panel-probe');
const { sha256 } = require('./forge-delivery');
const runner = require('../extensions/forge-vscode/test/mount-probe');
const panel = require('./forge-panel-source');
const personal = require('./forge-personal-context');

const repo = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-panel-offline-'));
const fake = path.join(temp, 'fake-code.js');
const log = path.join(temp, 'calls.jsonl');
const marker = path.join(temp, 'shell-must-not-run');
const pass = name => console.log(`PASS C05 probe ${name}`);
const copy = value => JSON.parse(JSON.stringify(value));
const home = path.join(temp, 'home'); fs.mkdirSync(home);
const workspace = path.join(temp, 'project'); fs.mkdirSync(path.join(workspace, '.gsd', 'milestones'), { recursive: true });
const nativeEnv = { ...process.env, HOME: home, USERPROFILE: home, FORGE_HOME: path.join(home, '.forge-agent'),
  FORGE_FAKE_LOG: log, FORGE_FAKE_MARKER: marker, FORGE_FAKE_PANEL: require.resolve('./forge-panel-source') };
const baseOptions = { cwd: temp, code: { command: process.execPath, args: [fake, 'mounted'] },
  claude: { command: process.execPath, args: [fake, 'claude'] }, claudeEntrypoint: fake,
  extensionsMetadata: false, env: nativeEnv, pollMs: 25, timeoutMs: 4000 };

// Every executable under test is Node and this fake, never the installed IDE.
fs.writeFileSync(fake, String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [scenario, ...args] = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(scenario === 'claude' ? '2.1.312 (Claude Code)' : '1.143.1\ne646868227c3e3a9e3f24277c8c7220be42c0be7\nx64');
} else if (args.includes('--list-extensions')) {
  console.log('unrelated.publisher@9.9.9\nopenai.chatgpt@0.4.7\nanthropic.claude-code@2.1.312\nopenai.bad@invalid');
} else {
  const target = process.env.FORGE_VSCODE_MOUNT_RESULT;
  const root = path.dirname(target);
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'user-data', 'User', 'settings.json'), 'utf8'));
  fs.appendFileSync(process.env.FORGE_FAKE_LOG, JSON.stringify({ pid: process.pid, args, root, target, settings,
    extensions: fs.readdirSync(path.join(root, 'extensions')), workspace: fs.readdirSync(args.at(-1)),
    ipc: process.env.VSCODE_IPC_HOOK_CLI || null }) + '\n');
  if (scenario === 'timeout') setTimeout(() => {}, 30000);
  else {
    if (scenario === 'updating') { console.error('Code is being updated: vscode-updating'); process.exitCode = 1; }
    if (scenario !== 'unknown' && scenario !== 'updating') {
      const value = { schema_version: 1, version: '1.143.1', app_name: 'Visual Studio Code', app_host: 'desktop', ui_kind: 1,
        extension_found: true, extension_active: true, container_revealed: true, view_visible: scenario !== 'not-mounted',
        synthetic_nodes: 4, reason: 'observed' };
      if (scenario === 'invalid') value.extra = 'unexpected';
      if (scenario.startsWith('v2-')) {
        const panel = require(process.env.FORGE_FAKE_PANEL);
        const now = scenario === 'v2-stale' ? process.env.FORGE_FAKE_NOW : new Date().toISOString();
        const dto = panel.readPanelSource({ cwd: args.at(-1), now });
        delete value.synthetic_nodes;
        Object.assign(value, { schema_version: 2, panel_nodes: 4, panel_status: dto.state.status,
          panel_reason: dto.state.reason, panel_stable_sha256: dto.stable_sha256, panel_generated_at: dto.generated_at });
        if (scenario === 'v2-mismatch') value.panel_stable_sha256 = '0'.repeat(64);
        if (scenario === 'v2-invisible') value.view_visible = false;
        if (scenario === 'v2-missing-time' || scenario === 'v2-changed-missing-time') value.panel_generated_at = null;
        if (scenario === 'v2-invalid-time') value.panel_generated_at = 'invalid';
        if (scenario === 'v2-changed' || scenario === 'v2-changed-missing-time') fs.appendFileSync(path.join(args.at(-1), '.gsd', 'forge', 'events.jsonl'), '{}\n');
        if (scenario === 'v2-store-changed') fs.appendFileSync(path.join(process.env.HOME, '.forge-personal', 'context.json'), ' ');
        if (scenario === 'v2-state-changed') {
          const file = path.join(args.at(-1), '.gsd', 'milestones', 'M001', 'M001-STATE.md');
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('**Phase:** execute-task', '**Phase:** complete-slice'));
        }
        if (scenario === 'v2-run-changed') fs.writeFileSync(path.join(args.at(-1), '.gsd', 'forge', 'runs', 'M001.json'), '{"changed":true}');
        if (scenario === 'v2-capture-changed') fs.appendFileSync(process.env.FORGE_FAKE_CAPTURE, ' edited');
        if (scenario === 'v2-questions-changed') fs.writeFileSync(path.join(args.at(-1), '.gsd', 'forge', 'questions', 'added.json'), '{}');
      }
      fs.writeFileSync(target, JSON.stringify(value) + '\n');
    }
    setTimeout(() => {}, 250);
  }
}
// subagentStatusLine: the bounded scanner must find a literal in this local entrypoint.
`, 'utf8');

function calls() { return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) : []; }
function fakeCensus() {
  return calls().filter(row => {
    try { process.kill(row.pid, 0); return true; } catch (_) { return false; }
  }).map(row => ({ ProcessId: row.pid, ParentProcessId: 0, CreationDate: `fixture-${row.pid}`, CommandLine: row.root }));
}
function options(scenario, extra = {}) {
  return { ...baseOptions, processCensus: fakeCensus, code: { command: process.execPath, args: [fake, scenario] }, ...extra };
}

async function run() {
  try {
    assert.equal(typeof probe.panelCheck, 'function');
    const empty = await probe.panelCheck(options('v2-match', { workspace }));
    assert.equal(empty.mount.result, 'mounted'); assert.equal(empty.source_match, 'match');
    assert.equal(empty.canonical.status, 'empty'); assert.equal(empty.canonical.reason, 'no-bindings');
    assert.equal(empty.sources_unchanged, true); assert.equal(empty.mount.cleanup.status, 'removed');
    assert.equal(fs.existsSync(workspace), true);
    assert.deepEqual(probe.privacyProblems(empty, { cwd: workspace }), []);
    assert(empty.mount.evidence.command.endsWith('<workspace>'));
    pass('v2 empty: no-bindings mounts with canonical match, placeholders and workspace preserved');

    const forge = path.join(workspace, '.gsd', 'forge'); fs.mkdirSync(path.join(forge, 'questions'), { recursive: true });
    fs.writeFileSync(path.join(forge, 'events.jsonl'), '');
    fs.mkdirSync(path.join(workspace, '.gsd', 'milestones', 'M001'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.gsd', 'milestones', 'M001', 'M001-STATE.md'),
      '---\nmilestone: M001\nkind: milestone\n---\n**Phase:** execute-task\n**Active Slice:** S05\n**Active Task:** T03\n');
    assert.equal(personal.bindWork({ cwd: workspace, userHome: home, id: 'M001', intent: 'create' }).status, 'ok');
    for (const [scenario, match, mounted] of [['v2-match', 'match', 'mounted'], ['v2-mismatch', 'mismatch', 'mounted'],
      ['v2-invisible', 'match', 'not-mounted'], ['v2-changed', 'unknown', 'mounted'],
      ['v2-store-changed', 'unknown', 'mounted'], ['v2-questions-changed', 'unknown', 'mounted'],
      ['v2-changed-missing-time', 'unknown', 'mounted'],
      ['v2-missing-time', 'unknown', 'mounted'], ['v2-invalid-time', 'unknown', 'unknown'], ['mounted', 'unknown', 'mounted']]) {
      const result = await probe.panelCheck(options(scenario, { workspace }));
      assert.equal(result.source_match, match, scenario); assert.equal(result.mount.result, mounted, scenario);
      assert.equal(result.sources_unchanged, !scenario.includes('changed'), scenario);
      assert.deepEqual(probe.privacyProblems(result, { cwd: workspace }), []);
      assert(!JSON.stringify(result).includes('M001')); assert(!JSON.stringify(result).includes(temp));
    }
    pass('panel-check: v2 match mismatch invisible and changed store events questions; v1 or missing invalid time stays unknown');

    // Bound STATE, run file and checkpoint captures feed the DTO, so a change in
    // any of them while mounting is unknown, never a misleading mismatch.
    const stateFile = path.join(workspace, '.gsd', 'milestones', 'M001', 'M001-STATE.md');
    const runsDir = path.join(forge, 'runs'); const runFile = path.join(runsDir, 'M001.json');
    const captureFile = path.join(workspace, 'proof.md'); fs.writeFileSync(captureFile, 'proof');
    nativeEnv.FORGE_FAKE_CAPTURE = captureFile;
    assert.equal(personal.saveCheckpoint({ cwd: workspace, userHome: home, id: 'M001', intent: 'checkpoint',
      checkpoint: { lastResult: [{ source: captureFile, text: 'Prova' }] } }).status, 'ok');
    const savedState = fs.readFileSync(stateFile);
    fs.mkdirSync(runsDir, { recursive: true });
    const clean = await probe.panelCheck(options('v2-match', { workspace }));
    assert.equal(clean.source_match, 'match'); assert.equal(clean.sources_unchanged, true);
    for (const scenario of ['v2-state-changed', 'v2-run-changed', 'v2-capture-changed']) {
      const result = await probe.panelCheck(options(scenario, { workspace }));
      assert.equal(result.sources_unchanged, false, scenario); assert.equal(result.source_match, 'unknown', scenario);
      fs.writeFileSync(stateFile, savedState); fs.rmSync(runFile, { force: true }); fs.writeFileSync(captureFile, 'proof');
    }
    const snapshotFiles = probe.sourceSnapshot(workspace, { env: nativeEnv });
    assert(Array.isArray(snapshotFiles));
    const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    for (const file of [stateFile, runFile, captureFile]) assert(snapshotFiles.some(row => same(row[0], file)), path.basename(file));
    fs.writeFileSync(stateFile, Buffer.alloc(1024 * 1024 + 1));
    assert.equal(probe.sourceSnapshot(workspace, { env: nativeEnv }), null);
    fs.writeFileSync(stateFile, savedState);
    fs.writeFileSync(runFile, Buffer.alloc(1024 * 1024 + 1));
    assert.equal(probe.sourceSnapshot(workspace, { env: nativeEnv }), null);
    fs.rmSync(runFile);
    fs.writeFileSync(captureFile, Buffer.alloc(1024 * 1024 + 1));
    assert.equal(probe.sourceSnapshot(workspace, { env: nativeEnv }), null);
    fs.writeFileSync(captureFile, 'proof');
    const realRuns = path.join(temp, 'linked-runs'); fs.mkdirSync(realRuns);
    fs.rmSync(runsDir, { recursive: true });
    fs.symlinkSync(realRuns, runsDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(probe.sourceSnapshot(workspace, { env: nativeEnv }), null);
    fs.unlinkSync(runsDir); fs.mkdirSync(runsDir);
    assert(Array.isArray(probe.sourceSnapshot(workspace, { env: nativeEnv })));
    pass('bound sources: STATE run and capture changes are unknown; oversized or linked bound sources refused');

    const fixture = require('./fixtures/agent-view/records.json');
    const observedNow = fixture.now;
    const eventRows = fixture.cases.find(row => row.name === 'recent').records;
    fs.writeFileSync(path.join(forge, 'events.jsonl'), eventRows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const atObservation = panel.readPanelSource({ cwd: workspace, env: nativeEnv, now: observedNow });
    const later = panel.readPanelSource({ cwd: workspace, env: nativeEnv, now: observedNow + 86400000 });
    assert.notEqual(atObservation.stable_sha256, later.stable_sha256);
    const stale = await probe.panelCheck(options('v2-stale', { workspace, env: { ...nativeEnv, FORGE_FAKE_NOW: String(observedNow) } }));
    assert.equal(stale.source_match, 'match'); assert.equal(stale.sources_unchanged, true);
    assert.equal(stale.observed.panel_generated_at, new Date(observedNow).toISOString());
    pass('observed time: stale threshold changes canonical hash but same observed instant matches unchanged sources');

    const physicalFile = path.join(temp, 'file'); fs.writeFileSync(physicalFile, 'preserve');
    const alias = path.join(temp, 'workspace-link');
    fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const beforeRejected = calls().length;
    for (const bad of ['relative', path.join(temp, 'absent'), physicalFile, alias, path.join(alias, '.gsd')]) {
      await assert.rejects(probe.mount(options('mounted', { workspace: bad })));
    }
    for (const bad of ['relative-code', path.join(temp, 'missing-code'), workspace, fake]) {
      await assert.rejects(probe.mount(options('mounted', { code: bad })));
    }
    fs.unlinkSync(alias);
    assert.equal(calls().length, beforeRejected);
    assert.equal(fs.readFileSync(physicalFile, 'utf8'), 'preserve');
    pass('input boundaries: relative absent file and linked workspace or launcher rejected before spawn');

    const v2 = copy(empty.observed);
    assert(probe.mountShape(v2)); assert(probe.mounted(v2));
    for (const change of [{ extra: 'hidden' }, { schema_version: 3 }, { panel_nodes: -1 }, { panel_reason: 'foreign' },
      { panel_stable_sha256: 'invalid' }, { panel_generated_at: 'invalid' },
      { panel_generated_at: '2026-02-31T00:00:00.000Z' }, { panel_status: 'success' }]) {
      assert.equal(Boolean(probe.mountShape({ ...v2, ...change })), false);
    }
    for (const reason of Object.keys(panel.STATE_REASONS)) {
      const valid = { ...v2, panel_reason: reason, panel_status: panel.STATE_REASONS[reason].status };
      assert(probe.mountShape(valid)); assert(probe.mounted(valid));
    }
    for (const change of [{ panel_nodes: 0 }, { view_visible: false }, { extension_active: false },
      { container_revealed: false }, { panel_status: null }, { panel_reason: null }]) assert.equal(Boolean(probe.mounted({ ...v2, ...change })), false);
    assert.deepEqual(probe.privacyProblems({ data: 'C:/Users/operator/private' }, { cwd: workspace }), ['personal-or-absolute-path']);
    assert(probe.privacyProblems({ data: path.basename(workspace) }, { cwd: workspace }).includes('workspace-name'));
    pass('v2 shape: exact keys closed states reasons counts hashes timestamps; privacy uses historical record scanner');

    const eventFile = path.join(forge, 'events.jsonl');
    const savedEvents = fs.readFileSync(eventFile);
    fs.writeFileSync(eventFile, Buffer.alloc(16 * 1024 * 1024 + 1));
    assert.equal(probe.sourceSnapshot(workspace, { env: nativeEnv }), null);
    fs.writeFileSync(eventFile, savedEvents);
    const questionFile = path.join(forge, 'questions', 'oversized.json');
    fs.writeFileSync(questionFile, Buffer.alloc(256 * 1024 + 1));
    assert.equal(probe.sourceSnapshot(workspace, { env: nativeEnv }), null);
    fs.unlinkSync(questionFile);
    const questionLink = path.join(forge, 'questions', 'linked');
    fs.symlinkSync(workspace, questionLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(probe.sourceSnapshot(workspace, { env: nativeEnv }), null);
    fs.unlinkSync(questionLink);
    assert(Array.isArray(probe.sourceSnapshot(workspace, { env: nativeEnv })));
    pass('source bounds: oversized events questions and linked source refused; snapshot recovers only after restored files');

    const id = probe.identify(baseOptions);
    assert.equal(id.client.version, '1.143.1');
    assert.equal(id.client.commit, 'e646868227c3e3a9e3f24277c8c7220be42c0be7');
    assert.equal(id.client.architecture, 'x64');
    assert.equal(id.client.mounted_instance, null);
    assert.equal(id.codex_surface.status, 'found');
    assert.deepEqual(id.codex_surface.extensions, [{ id: 'anthropic.claude-code', version: '2.1.312' }, { id: 'openai.chatgpt', version: '0.4.7' }]);
    assert.equal(id.client.evidence.exit_code, 0);
    assert.equal(id.client.evidence.output_sha256.length, 64);
    const absent = probe.identify({ ...baseOptions, code: 'missing-panel-probe-executable', env: { PATH: '', TERM_PROGRAM: 'vscode', TERM_PROGRAM_VERSION: '1.143.1' } });
    assert.equal(absent.client.version, 'unknown');
    assert.equal(absent.client.commit, 'unknown');
    assert.equal(absent.codex_surface.status, 'unknown');
    assert.deepEqual(absent.client.terminal, { program: 'vscode', version: '1.143.1' });
    const metadata = path.join(temp, 'extensions.json');
    fs.writeFileSync(metadata, JSON.stringify([{ identifier: { id: 'anthropic.claude-code' }, version: '2.1.312', location: { path: '/private/unrelated' } },
      { identifier: { id: 'unrelated.publisher' }, version: '9.9.9' }, { identifier: { id: 'openai.chatgpt' }, version: '0.4.7' }]));
    assert.deepEqual(probe.identify({ ...baseOptions, extensionsMetadata: metadata }).codex_surface.extensions, id.codex_surface.extensions);
    assert(!JSON.stringify(id).includes('unrelated'));
    pass('identify: client version commit arch and terminal sources, allowed publishers only, unavailable stays unknown');

    const install = path.join(temp, 'distribution');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    const shim = path.join(install, 'bin', 'code.cmd');
    const gui = path.join(install, 'Code.exe');
    fs.writeFileSync(shim, '@echo off\nset ELECTRON_RUN_AS_NODE=1\n"%~dp0..\\Code.exe" "fixed-cli.js" %*\n');
    fs.writeFileSync(gui, 'fixture identity only, never executed');
    assert.equal(probe.codePath(shim), shim); assert.equal(probe.codePath(gui), gui);
    const launcherAlias = path.join(temp, 'launcher-link');
    fs.symlinkSync(install, launcherAlias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => probe.codePath(path.join(launcherAlias, 'bin', 'code.cmd')), /code-link/);
    fs.unlinkSync(launcherAlias);
    assert.deepEqual(probe.nativeMountTarget({ file: shim, prefix: [] }, 'win32'), { file: gui, prefix: [], launcher: 'installed-gui-executable' });
    fs.writeFileSync(shim, '@echo off\nunrecognized operator launcher');
    assert.equal(probe.nativeMountTarget({ file: shim, prefix: [] }, 'win32').launcher, 'code-cli');
    assert.equal(probe.nativeMountTarget({ file: shim, prefix: ['literal'] }, 'win32').launcher, 'injected-test-executable');
    assert.equal(probe.nativeMountTarget({ file: shim, prefix: [] }, 'linux').launcher, 'code-cli');
    pass('launcher: only recognized installed Windows shim resolves sibling GUI; foreign layout and explicit fake invocation preserved');

    const success = await probe.mount(options('mounted', { env: { ...nativeEnv, VSCODE_IPC_HOOK_CLI: 'operator-ipc' } }));
    assert.equal(success.result, 'mounted', JSON.stringify(success));
    assert.equal(success.cleanup.status, 'removed');
    assert.equal(success.evidence.process_exit, 'confirmed');
    assert.equal(success.evidence.shell, false);
    assert.equal(success.evidence.exit_code, 0);
    const first = calls().at(-1);
    assert(!fs.existsSync(first.root));
    assert.equal(first.ipc, null);
    assert.deepEqual(first.extensions, []);
    assert.deepEqual(first.workspace, []);
    for (const flag of ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', '--wait']) assert(first.args.includes(flag));
    assert.deepEqual(first.args.filter((arg, index) => first.args[index - 1] === '--disable-extension'), ['vscode.git', 'vscode.git-base', 'vscode.github']);
    assert(!first.args.some(arg => /no-sandbox|disable-gpu-sandbox/.test(arg)));
    assert.equal(first.args[first.args.indexOf('--user-data-dir') + 1], path.join(first.root, 'user-data'));
    assert.equal(first.args[first.args.indexOf('--extensions-dir') + 1], path.join(first.root, 'extensions'));
    assert(first.args.includes(`--extensionDevelopmentPath=${path.join(repo, 'extensions', 'forge-vscode')}`));
    assert(first.args.includes(`--extensionTestsPath=${path.join(repo, 'extensions', 'forge-vscode', 'test', 'mount-probe.js')}`));
    assert.deepEqual(first.settings, { 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
      'extensions.autoCheckUpdates': false, 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'workbench.enableExperiments': false,
      'git.enabled': false, 'git.autoRepositoryDetection': false, 'git.autofetch': false });
    const raw = JSON.stringify(success.evidence.observed) + '\n';
    assert.equal(success.evidence.result_sha256, sha256(raw));
    assert(success.evidence.duration_ms >= 0);
    pass('mount: isolated settings argv development runner and IPC boundary, all four conditions observed, exact result hash, owned cleanup');

    const failed = await probe.mount(options('not-mounted'));
    assert.equal(failed.result, 'not-mounted');
    assert.equal(failed.evidence.observed.view_visible, false);
    assert.equal(failed.cleanup.status, 'removed');
    const unknown = await probe.mount(options('unknown'));
    assert.equal(unknown.result, 'unknown');
    assert.equal(unknown.reason, 'result-channel-unavailable');
    assert.equal(unknown.evidence.result_sha256, null);
    const invalid = await probe.mount(options('invalid'));
    assert.equal(invalid.result, 'unknown');
    assert.equal(invalid.evidence.observed, null);
    const updating = await probe.mount(options('updating'));
    assert.equal(updating.result, 'unknown');
    assert.equal(updating.reason, 'vscode-update-in-progress');
    assert.equal(updating.evidence.exit_code, 1);
    assert.equal(updating.diagnostics.classification, 'host-environment');
    assert(updating.diagnostics.counts['vscode-update-in-progress'] > 0);
    assert.equal(probe.gate(probe.MECHANISM, updating).required, false);
    const unavailable = await probe.mount(options('mounted', { code: { command: 'missing-panel-probe-executable', args: [] } }));
    assert.equal(unavailable.result, 'unknown');
    assert.equal(unavailable.reason, 'launch-failed');
    assert.equal(unavailable.cleanup.status, 'removed');
    const timeout = await probe.mount(options('timeout', { timeoutMs: 400 }));
    assert.equal(timeout.result, 'unknown');
    assert.equal(timeout.reason, 'timeout');
    assert.equal(timeout.evidence.error_code, 'ETIMEDOUT');
    assert.equal(timeout.cleanup.status, 'removed');
    pass('outcomes: not-mounted differs from absent invalid unavailable and timed-out unknown; exit duration hashes retained');
    pass('environment: explicit VS Code update mutex failure stays unknown host-environment with no functional G1');

    const pending = await probe.mount(options('mounted', { processCensus: () => null }));
    const pendingRoot = calls().at(-1).root;
    assert.equal(pending.result, 'mounted');
    assert.equal(pending.cleanup.status, 'pending');
    assert.equal(pending.evidence.process_exit, 'unknown');
    assert(fs.existsSync(pendingRoot));
    assert.equal((await probe.cleanup(pendingRoot, true)).status, 'removed');
    const removedFailure = await probe.mount(options('mounted', { remove: () => { throw new Error('busy'); } }));
    const busyRoot = calls().at(-1).root;
    assert.equal(removedFailure.cleanup.reason, 'remove-failed');
    assert(fs.existsSync(busyRoot));
    assert.equal((await probe.cleanup(busyRoot, true)).status, 'removed');
    const owned = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-vscode-probe-'));
    const foreign = path.join(temp, 'foreign'); fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'keep'), 'preserved');
    fs.symlinkSync(foreign, path.join(owned, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await probe.cleanup(owned, true)).status, 'pending');
    assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'preserved');
    fs.unlinkSync(path.join(owned, 'escape')); fs.rmdirSync(owned);
    assert.equal((await probe.cleanup(temp, true)).status, 'pending');
    const tracked = new Map();
    const rows = [{ ProcessId: 10, ParentProcessId: 0, CreationDate: 'a', CommandLine: 'other-profile' },
      { ProcessId: 20, ParentProcessId: 0, CreationDate: 'b', CommandLine: 'unique-own-root' },
      { ProcessId: 21, ParentProcessId: 20, CreationDate: 'c', CommandLine: 'extension-host' }];
    assert.deepEqual(probe.trackProcesses(rows, 'unique-own-root', tracked).map(row => row.ProcessId), [20, 21]);
    assert.deepEqual(probe.trackProcesses([{ ...rows[2], ParentProcessId: 1 }], 'unique-own-root', tracked).map(row => row.ProcessId), [21]);
    assert.deepEqual(probe.trackProcesses([{ ...rows[2], CreationDate: 'pid-reused', ParentProcessId: 1 }], 'unique-own-root', tracked), []);
    assert.equal(probe.ownsRootArgument('"unique-own-root-other/user-data"', 'unique-own-root'), false);
    assert.equal(probe.ownsRootArgument('prefixunique-own-root', 'unique-own-root'), false);
    assert.equal(probe.ownsRootArgument('--user-data-dir="unique-own-root/user-data"', 'unique-own-root'), true);
    assert.equal(probe.ownsRootArgument('--user-data-dir "unique-own-root/user-data"', 'unique-own-root'), true);
    assert.equal(probe.trackProcesses([{ ProcessId: 20, CommandLine: 'unique-own-root' }], 'unique-own-root', new Map()), false);
    assert.deepEqual(probe.trackProcesses([{ ProcessId: 0 }], 'unique-own-root', new Map()), []);
    pass('cleanup safety: unknown process exit busy files foreign roots links operator processes and reused PIDs never authorize deletion');

    // Metacharacters are a literal argv element to the real canonical Node invocation.
    const injection = `& type nul > ${marker}`;
    const literal = await probe.mount(options('mounted', { code: { command: process.execPath, args: [fake, 'mounted', injection] } }));
    assert.equal(literal.result, 'mounted');
    assert(calls().at(-1).args.includes(injection));
    assert(!fs.existsSync(marker));
    pass('shell boundary: fake code runs with process.execPath and metacharacters remain literal argv');

    const originalLoad = Module._load;
    const priorResult = process.env.FORGE_VSCODE_MOUNT_RESULT;
    const runRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-vscode-probe-'));
    const runTarget = path.join(runRoot, 'mount-result.json');
    let activated = 0, revealed = 0;
    const treeView = { visible: false };
    let refreshed = false;
    const panelState = { status: 'ok', reason: 'snapshot', stable_sha256: 'a'.repeat(64), generated_at: '2026-01-01T00:00:00.000Z' };
    const api = Object.freeze({ treeView, async refresh() { await Promise.resolve(); refreshed = true; }, state() { assert(refreshed); return panelState; },
      provider: Object.freeze({ getChildren: () => [{ label: 'SECRET-WORK-LABEL', description: 'PRIVATE-TEXT' }] }) });
    const extension = { isActive: false, async activate() { activated++; this.isActive = true; return api; } };
    const vscode = { version: '1.143.1', env: { appName: 'Visual Studio Code', appHost: 'desktop', uiKind: 1 },
      extensions: { getExtension(id) { assert.equal(id, 'forge-agent.forge-vscode'); return extension; } },
      commands: { async executeCommand(command) { assert.equal(command, 'workbench.view.extension.forge'); revealed++; treeView.visible = true; } } };
    try {
      Module._load = function (name, parent, isMain) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain); };
      process.env.FORGE_VSCODE_MOUNT_RESULT = runTarget;
      await runner.run();
      const value = JSON.parse(fs.readFileSync(runTarget, 'utf8'));
      assert(probe.mountShape(value)); assert(probe.mounted(value));
      assert.equal(activated, 1); assert.equal(revealed, 1);
      assert.equal(value.panel_nodes, 1); assert.equal(value.schema_version, 2);
      assert.equal(value.panel_generated_at, panelState.generated_at);
      assert.equal(value.panel_stable_sha256, panelState.stable_sha256);
      assert(!JSON.stringify(value).includes('SECRET')); assert(!JSON.stringify(value).includes('PRIVATE'));
      await assert.rejects(runner.run(), /already-exists/);
      for (const bad of ['relative.json', path.join(temp, 'outside.json'), path.join(os.tmpdir(), 'outside.json'), path.join(runRoot, '..', 'outside.json')]) {
        process.env.FORGE_VSCODE_MOUNT_RESULT = bad;
        await assert.rejects(runner.run(), /mount-result/);
        assert(!fs.existsSync(bad));
      }
      fs.unlinkSync(runTarget);
      fs.symlinkSync(process.platform === 'win32' ? foreign : path.join(foreign, 'keep'), runTarget,
        process.platform === 'win32' ? 'junction' : 'file');
      process.env.FORGE_VSCODE_MOUNT_RESULT = runTarget;
      await assert.rejects(runner.run(), /already-exists/);
      fs.unlinkSync(runTarget);
      fs.rmdirSync(runRoot);
      fs.symlinkSync(foreign, runRoot, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(runner.run(), /link/);
      fs.unlinkSync(runRoot);
    } finally {
      Module._load = originalLoad;
      if (priorResult === undefined) delete process.env.FORGE_VSCODE_MOUNT_RESULT;
      else process.env.FORGE_VSCODE_MOUNT_RESULT = priorResult;
    }
    pass('extension runner: bounded refresh then same state time hash and real nodes; no labels IDs or text; exclusive temp-only link-safe output');

    const claude = probe.claude(baseOptions);
    assert.equal(claude.version, '2.1.312');
    assert.equal(claude.subagent_statusline.static_reference, 'found');
    assert.equal(claude.subagent_statusline.documentation_sha256, 'a2391a0f4b8892bd32c0ea95d3d3d25f319c6891c963895ea0f2dd4c74150aa4');
    assert.equal(claude.subagent_statusline.runtime_display, 'unknown');
    const plain = path.join(temp, 'plain.js'); fs.writeFileSync(plain, 'no literal');
    assert.equal(probe.scanLiteral(plain), 'not-found');
    assert.equal(probe.scanLiteral(path.join(temp, 'missing')), 'unknown');
    pass('Claude: observed version bounded static found not-found unknown documented hash and runtime unknown until S03');

    const observations = { identification: id, mounting: success, claudeTerminal: claude };
    const record = probe.record(observations);
    assert.equal(probe.validateRecord(record, baseOptions).valid, true, JSON.stringify(probe.validateRecord(record, baseOptions)));
    assert.equal(record.client.consistency, 'same-version');
    assert.deepEqual(record.client.mounted_instance, { version: '1.143.1', app_name: 'Visual Studio Code', app_host: 'desktop', ui_kind: 1 });
    assert.equal(record.g1.required, false);
    assert.equal(record.acceptance.visual_uat, 'pending-final-round');
    for (const mutate of [value => { value.client.version = 'C:/Users/operator/profile'; },
      value => { value.client.commit = '/home/operator/private'; }, value => { value.client.version = path.basename(temp); },
      value => { value.codex_surface.extensions.push({ id: 'unrelated.publisher', version: '1.2.3' }); },
      value => { value.mount.evidence.observed.view_visible = false; }, value => { value.mount.evidence.result_sha256 = null; },
      value => { value.mount.evidence.exit_code = 1; }, value => { value.claude_terminal.subagent_statusline.runtime_display = 'observed'; },
      value => { value.acceptance.visual_uat = 'passed'; }, value => { value.mechanism.listener = 'http'; }]) {
      const value = copy(record); mutate(value); assert.equal(probe.validateRecord(value, baseOptions).valid, false);
    }
    assert.equal(probe.validateRecord(probe.record({ ...observations, mounting: unknown }), baseOptions).valid, true);
    assert.equal(record.subagent_surfaces[2].observed, 'static-only');
    for (const reference of ['unknown', 'not-found']) {
      const degraded = { ...claude, evidence: { ...claude.evidence, error_code: 'executable-unavailable' },
        subagent_statusline: { ...claude.subagent_statusline, static_reference: reference } };
      const value = probe.record({ ...observations, claudeTerminal: degraded });
      assert.equal(value.subagent_surfaces[2].observed, 'unknown');
      assert.equal(value.claude_terminal.subagent_statusline.runtime_display, 'unknown');
      assert.equal(probe.validateRecord(value, baseOptions).valid, true);
      const forged = copy(value); forged.subagent_surfaces[2].observed = 'static-only';
      assert.equal(probe.validateRecord(forged, baseOptions).valid, false);
    }
    const mismatch = copy(record); mismatch.subagent_surfaces[2].observed = 'unknown';
    assert.equal(probe.validateRecord(mismatch, baseOptions).valid, false);
    pass('record validator: coherent client TreeView local no server record; absolute user workspace foreign extension and false mount or UAT proofs rejected');

    for (const mount of [failed, unknown, success]) {
      const value = probe.record({ ...observations, mounting: mount });
      assert.equal(value.g1.required, mount.result === 'not-mounted');
      assert.equal(value.g1.question_id, mount.result === 'not-mounted' ? 'g1_panel_surface' : null);
      assert.equal(value.criterion_c05, mount.result === 'mounted' ? 'runtime-mounted-visual-pending' : 'pending');
      assert.equal(value.mount.reexecute, 'node scripts/forge-panel-probe.js --mount --json');
      assert.equal(probe.validateRecord(value, baseOptions).valid, true);
    }
    for (const change of [{ server_required: true }, { listener: 'http' }, { hosting: 'external' }]) {
      assert.equal(probe.gate({ ...probe.MECHANISM, ...change }, unknown).question_id, 'g1_panel_surface');
    }
    assert(probe.gate(probe.MECHANISM, failed).question.options[0].label.includes('recomendado'));
    pass('G1: not-mounted or infrastructure requires one functional question; unknown preserves C05 and exact reexecution without opening G1');

    // The exported CLI entrypoint permits trusted dependency injection only in this offline suite.
    const originalLog = console.log;
    let cliOutput = [];
    try {
      console.log = line => cliOutput.push(String(line));
      assert.equal(await probe.main(['--record', '--out', 'record.json'], options('mounted')), 0);
      const saved = JSON.parse(fs.readFileSync(path.join(temp, 'record.json'), 'utf8'));
      assert.equal(probe.validateRecord(saved, baseOptions).valid, true);
      assert.equal(await probe.main(['--validate-record', 'record.json'], baseOptions), 0);
      fs.writeFileSync(path.join(temp, 'invalid.json'), '{');
      assert.equal(await probe.main(['--validate-record', 'invalid.json'], baseOptions), 1);
      assert.equal(await probe.main(['--panel-check', '--workspace', workspace, '--json', '--timeout-ms', '4000'], options('v2-match')), 0);
      for (const scenario of ['v2-mismatch', 'v2-invisible', 'mounted', 'v2-changed']) {
        assert.equal(await probe.main(['--panel-check', '--workspace', workspace], options(scenario)), 1);
      }
      for (const args of [[], ['--mount', '--claude'], ['--mount', '--timeout-ms', '0'], ['--mount', '--timeout-ms', '300001'], ['--bad'], ['--record'], ['--identify', 'extra'], ['--record', '--out', '../escape.json']]) {
        assert.equal(await probe.main(args, baseOptions), 2);
      }
      for (const args of [['--panel-check'], ['--panel-check', '--workspace'], ['--panel-check', '--workspace', 'relative'],
        ['--panel-check', '--workspace', workspace, '--workspace', workspace], ['--mount', '--code', 'relative'],
        ['--mount', '--code'], ['--identify', '--code', shim], ['--claude', '--workspace', workspace],
        ['--panel-check', '--workspace', workspace, '--code', path.join(temp, 'absent')],
        ['--mount', '--json', '--json'], ['--panel-check', '--workspace', workspace, '--timeout-ms', 'NaN']]) {
        assert.equal(await probe.main(args, baseOptions), 2);
      }
    } finally { console.log = originalLog; }
    assert(cliOutput.some(line => line.startsWith('PASS C05 record:')));
    const validateCli = spawnSync(process.execPath, [path.join(repo, 'scripts', 'forge-panel-probe.js'), '--validate-record', '../outside.json'], { cwd: repo, encoding: 'utf8', shell: false, timeout: 10000 });
    assert.equal(validateCli.status, 1);
    const discovery = spawnSync(process.execPath, ['scripts/run-tests.js', '--list', '--match', 'panel-probe'], { cwd: repo, encoding: 'utf8', shell: false, timeout: 10000 });
    assert.equal(discovery.status, 0, discovery.stderr);
    assert.equal(discovery.stdout.trim(), 'forge-panel-probe.test.js');
    pass('CLI: record validate v1 retained; panel-check exits 0 mounted match 1 otherwise 2 invalid duplicate missing incompatible options; discovery');

    const published = JSON.parse(fs.readFileSync(path.join(repo, 'docs', 'panel-feasibility.json'), 'utf8'));
    assert.equal(probe.validateRecord(published).valid, true);
    const documentation = fs.readFileSync(path.join(repo, 'docs', 'panel-feasibility.md'), 'utf8');
    assert(documentation.includes(`**${published.mount.result}**`));
    for (const value of [published.client.version, published.client.commit, published.claude_terminal.version,
      published.claude_terminal.subagent_statusline.documentation_sha256, published.mount.reexecute]) assert(documentation.includes(value));
    for (const attempt of [...(published.previous_mount_attempts || []), { mount: published.mount }]) {
      assert(documentation.includes(`${attempt.mount.evidence.duration_ms} ms`));
    }
    assert.equal(published.acceptance.visual_uat, 'pending-final-round');
    assert(documentation.includes('pending-final-round'));
    assert(documentation.includes('não demonstra') || documentation.includes('não prova'));
    assert(documentation.includes('TreeView') && documentation.includes('View Container'));
    assert(documentation.includes('server_required: false') && documentation.includes('listener: none') && documentation.includes('hosting: none'));
    assert.equal(published.mount.result === 'unknown' && published.g1.required, false);
    assert.equal(sha256(fs.readFileSync(path.join(repo, 'docs', 'panel-feasibility.json'))), '4bcaf7c9c9ffd9d28d0b740f1ff9f76e7a898234496587238cfb3c0e96789e43');
    assert.equal(sha256(fs.readFileSync(path.join(repo, 'docs', 'panel-feasibility.md'))), 'a2e0696305f05a1df0b92a2eca31ced189b560a9b9fe2805be1d9b361e04c3e4');
    pass('published record: real client Claude and every attempt agree with readable docs; local mechanism G1 C05 and final visual acceptance stay explicit');
  } finally {
    // Test-owned fixture tree contains no surviving child; mount roots are cleaned above.
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
