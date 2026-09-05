#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('./forge-installer.js');
const capabilities = require('./forge-capabilities.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-installer space-Ω-'));
  const forgeHome = path.join(root, 'Forge Home');
  const claudeHome = path.join(root, 'Claude Home');
  const codexHome = path.join(root, 'Codex Home');
  const projectRoot = path.join(root, 'Project Root');
  const options = { repo: path.resolve(__dirname, '..'), forgeHome, claudeHome, codexHome, projectRoot, userHome: root, skipCapabilityCheck: true };
  return { root, forgeHome, claudeHome, codexHome, projectRoot, options, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function files(root) { return fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort() : []; }

test('rejects an unknown runtime before writing', () => {
  const data = fixture();
  try { assert.throws(() => installer.install({ ...data.options, runtime: 'agy' }), /runtime inválido/); assert.strictEqual(fs.existsSync(data.forgeHome), false); } finally { data.cleanup(); }
});

test('dry-run plans Claude-only without touching Forge, Claude, or Codex homes', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'claude', dryRun: true });
    assert.strictEqual(report.dry_run, true);
    assert(report.plan.some((entry) => entry.destination === path.join(data.forgeHome, 'scripts')) || report.plan.some((entry) => entry.destination.includes(`${path.sep}scripts`)));
    assert.strictEqual(fs.existsSync(data.forgeHome), false);
    assert.strictEqual(fs.existsSync(data.claudeHome), false);
    assert.strictEqual(fs.existsSync(data.codexHome), false);
  } finally { data.cleanup(); }
});

test('shared references and cross-platform launchers are installed by the Node core', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'both' });
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'shared', 'forge-review.md')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'shared', 'forge-dispatch.md')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'schemas', 'challenge.schema.json')), true);
    assert.strictEqual(fs.existsSync(path.join(data.root, '.local', 'bin', 'forge-status.cmd')), true);
    assert(report.plan.some((entry) => entry.destination && entry.destination.endsWith(path.join('shared', 'forge-state.md'))));
  } finally { data.cleanup(); }
});

test('--with-app is planned on macOS, executed through bash, and skipped elsewhere', () => {
  const plan = [];
  const calls = [];
  const repo = path.resolve(__dirname, '..');
  const dry = installer.installApp(repo, plan, { withApp: true, dryRun: true }, 'darwin');
  assert.strictEqual(dry.status, 'planned');
  assert(plan.some((entry) => entry.op === 'app-build'));
  const built = installer.installApp(repo, [], {
    withApp: true,
    spawnSync: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; },
  }, 'darwin');
  assert.strictEqual(built.status, 'installed');
  assert.deepStrictEqual(calls[0].args.slice(-1), ['--install']);
  assert.strictEqual(calls[0].options.shell, false);
  assert.strictEqual(installer.installApp(repo, [], { withApp: true }, 'linux').reason, 'macos-only');
  assert.strictEqual(installer.installApp(repo, [], { withApp: true }, 'win32').reason, 'macos-only');
});

test('Claude-only writes shared core once and only Claude projection', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(data.forgeHome, 'VERSION'), 'utf8'), `${installer.VERSION}\n`);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'scripts', 'forge-home.js')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'forge-capabilities.json')), true);
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, 'manifest.json')), true);
    assert.strictEqual(fs.existsSync(path.join(data.claudeHome, 'agents')), true);
    assert.strictEqual(fs.existsSync(path.join(data.projectRoot, 'CLAUDE.md')), true);
    assert.strictEqual(fs.existsSync(data.codexHome), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(data.forgeHome, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.adapters), ['claude']);
  } finally { data.cleanup(); }
});

test('Codex-only does not read or write Claude home and both keeps one core', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, runtime: 'codex' });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(fs.existsSync(data.claudeHome), false);
    assert.strictEqual(fs.existsSync(path.join(data.projectRoot, 'AGENTS.md')), true);
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), true);
    assert.match(fs.readFileSync(path.join(data.codexHome, 'config.toml'), 'utf8'), /context-used/);
    const both = installer.install({ ...data.options, runtime: 'both', update: true });
    assert.strictEqual(both.ok, true);
    assert.strictEqual(fs.existsSync(path.join(data.claudeHome, 'agents')), true);
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), true);
    assert.strictEqual(files(data.forgeHome).filter((name) => name === 'scripts').length, 1);
  } finally { data.cleanup(); }
});

test('Codex install adds status line to user config; dry-run and updates preserve user choices', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.codexHome, { recursive: true });
    const configPath = path.join(data.codexHome, 'config.toml');
    const original = 'model = "operator-model"\r\n[tui]\r\nnotifications = false\r\n';
    fs.writeFileSync(configPath, original);
    installer.install({ ...data.options, runtime: 'codex', dryRun: true });
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    installer.install({ ...data.options, runtime: 'codex' });
    const installed = fs.readFileSync(configPath, 'utf8');
    assert.match(installed, /context-used/);
    assert.match(installed, /model = "operator-model"/);
    assert.match(installed, /notifications = false/);
    // An older installation without the option receives it on --update too.
    fs.writeFileSync(configPath, original);
    installer.install({ ...data.options, runtime: 'codex', update: true });
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), installed);
    const customized = installed.replace(/status_line = [^\r\n]+/, 'status_line = []');
    fs.writeFileSync(configPath, customized);
    installer.install({ ...data.options, runtime: 'codex', update: true });
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), customized);
  } finally { data.cleanup(); }
});

test('ambiguous Codex config is preserved with actionable status-line guidance', () => {
  const destination = path.join('Codex Home', 'config.toml');
  const output = installer.render({ runtime: 'codex', forge_home: 'Forge Home', plan: [], manifest: {
    adapters: { codex: { conflicts: [{ destination, reason: 'status-line-manual-merge' }] } },
  } });
  assert(output.includes(destination));
  assert(output.includes('/statusline'));
  assert(!output.includes('--migrate-legacy'));
});

test('update backs up managed files and preserves prefs and unmanaged files', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    const prefs = path.join(data.forgeHome, 'forge-agent-prefs.jsonc');
    const unmanaged = path.join(data.forgeHome, 'operator-note.txt');
    const managedAgent = path.join(data.claudeHome, 'agents', 'forge-executor.md');
    fs.writeFileSync(prefs, '{"operator":true}\n');
    fs.writeFileSync(unmanaged, 'keep\n');
    fs.writeFileSync(managedAgent, 'old managed agent\n');
    const report = installer.install({ ...data.options, runtime: 'claude', update: true });
    assert(report.backup && fs.existsSync(report.backup));
    assert.strictEqual(fs.readFileSync(prefs, 'utf8'), '{"operator":true}\n');
    assert.strictEqual(fs.readFileSync(unmanaged, 'utf8'), 'keep\n');
    assert(fs.readdirSync(path.join(data.forgeHome, 'backups')).length >= 1);
    assert.strictEqual(fs.readFileSync(path.join(report.backup, 'adapters', 'claude', 'agents', 'forge-executor.md'), 'utf8'), 'old managed agent\n');
  } finally { data.cleanup(); }
});

test('legacy Claude preference migrates without removing source', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.claudeHome, { recursive: true });
    const legacy = path.join(data.claudeHome, 'forge-agent-prefs.jsonc');
    fs.writeFileSync(legacy, '{"legacy":true}\n');
    installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(fs.readFileSync(legacy, 'utf8'), '{"legacy":true}\n');
    assert.strictEqual(fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc'), 'utf8'), '{"legacy":true}\n');
  } finally { data.cleanup(); }
});

test('legacy Claude projections are reported first and migrated only with explicit opt-in', () => {
  const data = fixture();
  try {
    fs.mkdirSync(path.join(data.claudeHome, 'agents'), { recursive: true });
    const legacyAgent = path.join(data.claudeHome, 'agents', 'forge-executor.md');
    fs.writeFileSync(legacyAgent, '---\nname: forge-executor\nlegacy: true\n---\n');
    const preserved = installer.install({ ...data.options, runtime: 'claude', update: true });
    const preservedManifest = preserved.manifest.adapters.claude;
    assert(preserved.backup && fs.existsSync(preserved.backup));
    assert(preservedManifest.conflicts.some((item) => item.destination === legacyAgent));
    assert.match(fs.readFileSync(legacyAgent, 'utf8'), /legacy: true/);
    const migrated = installer.install({ ...data.options, runtime: 'claude', update: true, migrateLegacy: true });
    assert.strictEqual(migrated.manifest.adapters.claude.conflicts.length, 0);
    assert.match(fs.readFileSync(legacyAgent, 'utf8'), /^<!-- forge-source:agents/m);
    assert(migrated.backup && fs.existsSync(migrated.backup));
  } finally { data.cleanup(); }
});

test('switching from Claude-only to both fills the missing Codex projection', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), false);
    const report = installer.install({ ...data.options, runtime: 'both' });
    assert.strictEqual(report.already_installed, undefined);
    assert.strictEqual(fs.existsSync(path.join(data.codexHome, 'agents')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(data.forgeHome, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(manifest.adapters).sort(), ['claude', 'codex']);
  } finally { data.cleanup(); }
});

test('user-owned project projection is reported as a conflict and never marked complete', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.projectRoot, { recursive: true });
    fs.writeFileSync(path.join(data.projectRoot, 'AGENTS.md'), '# operator-owned\n');
    const first = installer.install({ ...data.options, runtime: 'codex' });
    assert(first.manifest.adapters.codex.conflicts.length > 0);
    const second = installer.install({ ...data.options, runtime: 'codex' });
    assert.strictEqual(second.already_installed, undefined);
    assert.match(fs.readFileSync(path.join(data.projectRoot, 'AGENTS.md'), 'utf8'), /operator-owned/);
  } finally { data.cleanup(); }
});

test('sentinels prove the non-selected home remains byte-identical', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.codexHome, { recursive: true });
    fs.mkdirSync(data.claudeHome, { recursive: true });
    const codexSentinel = path.join(data.codexHome, 'operator-sentinel.txt');
    const claudeSentinel = path.join(data.claudeHome, 'operator-sentinel.txt');
    fs.writeFileSync(codexSentinel, 'codex untouched\r\n');
    installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(fs.readFileSync(codexSentinel, 'utf8'), 'codex untouched\r\n');
    fs.writeFileSync(claudeSentinel, 'claude untouched\r\n');
    installer.install({ ...data.options, runtime: 'claude' });
    assert.strictEqual(fs.readFileSync(claudeSentinel, 'utf8'), 'claude untouched\r\n');
  } finally { data.cleanup(); }
});

test('repeating a selected install is byte-idempotent', () => {
  const data = fixture();
  try {
    const first = installer.install({ ...data.options, runtime: 'both' });
    const snapshot = {};
    for (const file of [path.join(data.forgeHome, 'VERSION'), path.join(data.forgeHome, 'manifest.json'), path.join(data.claudeHome, 'agents', 'forge-executor.md'), path.join(data.codexHome, 'agents', 'forge-executor.toml')]) snapshot[file] = fs.readFileSync(file);
    const second = installer.install({ ...data.options, runtime: 'both' });
    assert.strictEqual(second.already_installed, true);
    for (const [file, bytes] of Object.entries(snapshot)) assert.deepStrictEqual(fs.readFileSync(file), bytes);
    assert.strictEqual(first.runtime, second.runtime);
  } finally { data.cleanup(); }
});

test('update dry-run keeps a deterministic non-colliding backup plan', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    const left = installer.install({ ...data.options, runtime: 'claude', update: true, dryRun: true });
    const right = installer.install({ ...data.options, runtime: 'claude', update: true, dryRun: true });
    assert.strictEqual(JSON.stringify(left.plan), JSON.stringify(right.plan));
    assert.match(left.backup || '', /dry-run/);
  } finally { data.cleanup(); }
});

test('update retires legacy Claude scripts only on apply and leaves a tombstone', () => {
  const data = fixture();
  try {
    const legacy = path.join(data.root, '.claude', 'scripts');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'forge-old.js'), 'legacy\n');
    const dry = installer.install({ ...data.options, runtime: 'claude', update: true, dryRun: true });
    assert(dry.plan.some((entry) => entry.op === 'retire' && entry.source === legacy));
    assert.strictEqual(fs.existsSync(path.join(legacy, 'forge-old.js')), true);
    const applied = installer.install({ ...data.options, runtime: 'claude', update: true });
    assert.strictEqual(fs.existsSync(path.join(legacy, 'README.md')), true);
    assert(applied.plan.some((entry) => entry.op === 'retire'));
    const second = installer.install({ ...data.options, runtime: 'claude', update: true });
    assert(second.plan.some((entry) => entry.op === 'skip' && entry.reason === 'already-retired'));
  } finally { data.cleanup(); }
});

// ── Retirement classifies before it moves ───────────────────────────────────
//
// Measured on a real 4.15.0 update: `retireLegacyScripts` renamed the whole
// `~/.claude/scripts` directory. 93 files moved, 91 of them `forge-*`. One of the
// other two was the operator's `svn-session-reconcile.py`, invoked by a
// `SessionStart` hook in `settings.json` — after the update that hook pointed at
// a file that no longer existed and failed silently at every session start. The
// `settings.json` is preserved as `user_owned`, so it stayed intact and aimed at
// nothing; only an operator who already knew the hook existed could notice.
test('retirement moves only what is ours — the operator script and its hook survive', () => {
  const data = fixture();
  try {
    const legacy = path.join(data.root, '.claude', 'scripts');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'forge-doctor.js'), 'fossil do forge\n');      // ours by name
    fs.writeFileSync(path.join(legacy, 'merge-settings.js'), 'fossil do forge\n');    // ours by inventory, no prefix
    fs.writeFileSync(path.join(legacy, 'svn-session-reconcile.py'), 'print(1)\n');    // the operator's own
    fs.writeFileSync(path.join(data.root, '.claude', 'settings.json'), `${JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'python ~/.claude/scripts/svn-session-reconcile.py', timeout: 45 }] }],
        PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command: 'node ~/.claude/scripts/forge-doctor.js' }] }],
      },
    }, null, 2)}\n`);

    const report = installer.install({ ...data.options, runtime: 'claude', update: true });
    const retire = report.plan.find((entry) => entry.op === 'retire');
    assert(retire, 'nada foi aposentado — o cenário não é o que este teste mede');
    assert.deepStrictEqual(retire.moved, ['forge-doctor.js', 'merge-settings.js'],
      'aposentou algo que o Forge não pode provar ser seu, ou deixou um fóssil executável');
    assert.deepStrictEqual(retire.retained, ['svn-session-reconcile.py']);

    // The acceptance criterion, at the level that matters: the operator's file is
    // still exactly where their hook points, byte for byte.
    assert.strictEqual(fs.readFileSync(path.join(legacy, 'svn-session-reconcile.py'), 'utf8'), 'print(1)\n');
    // ...and ours really did leave, into the backup the tombstone names.
    assert.strictEqual(fs.existsSync(path.join(legacy, 'forge-doctor.js')), false);
    assert.strictEqual(fs.existsSync(path.join(retire.destination, 'forge-doctor.js')), true);
    assert.strictEqual(fs.existsSync(path.join(retire.destination, 'merge-settings.js')), true);

    // Both references are named, with the action that applies to each: the
    // operator's stays, ours went — and the one that went is the loud case.
    assert.deepStrictEqual(
      retire.settings_references.map((item) => [item.script, item.action]).sort(),
      [['forge-doctor.js', 'retired'], ['svn-session-reconcile.py', 'retained']],
    );

    const text = installer.render(report);
    const warned = text.split('\n').filter((line) => line.includes('⚠'));
    assert(text.includes('  [retained] svn-session-reconcile.py'), `o resumo não nomeou o que ficou:\n${text}`);
    assert(warned.some((line) => line.includes('svn-session-reconcile.py') && line.includes('preservado no lugar')),
      `o resumo não diz que o hook do operador continua válido:\n${text}`);
    assert(warned.some((line) => line.includes('forge-doctor.js') && line.includes('FOI aposentado')),
      `o resumo não avisa sobre o hook que aponta para um arquivo aposentado:\n${text}`);
    assert.strictEqual(warned.length, 2, `avisos esperados: 2, veio ${warned.length}:\n${text}`);

    // The tombstone tells the same truth as the plan.
    assert.match(fs.readFileSync(path.join(legacy, installer.TOMBSTONE), 'utf8'), /svn-session-reconcile\.py/);

    // Idempotence with an orphan present: `already-retired` is a statement about
    // OUR content, not about the folder. Without this the directory would be
    // retired again on every future update, forever.
    const second = installer.install({ ...data.options, runtime: 'claude', update: true });
    const skipped = second.plan.find((entry) => entry.op === 'skip' && entry.reason === 'already-retired');
    assert(skipped, 'com um órfão preservado, a segunda execução não reportou already-retired');
    assert.deepStrictEqual(skipped.moved, []);
    assert.deepStrictEqual(skipped.retained, ['svn-session-reconcile.py']);
    assert.strictEqual(fs.readFileSync(path.join(legacy, 'svn-session-reconcile.py'), 'utf8'), 'print(1)\n');
  } finally { data.cleanup(); }
});

// Regression for a real incident: a local-dev setup symlinks ~/.claude/scripts
// straight into the repo's own scripts/ (edit the repo, skip reinstalling to
// see it live). retireLegacyScripts walked through that link and renamed the
// repo's own files into the backup by real path — ~400 files gone from the
// source tree in one `--update` run. The guard must refuse to touch a legacy
// dir whose realpath resolves inside the repo being installed from.
test('retireLegacyScripts refuses a legacy dir symlinked into the source repo', () => {
  const data = fixture();
  try {
    const repo = path.join(data.root, 'Repo');
    const repoScripts = path.join(repo, 'scripts');
    fs.mkdirSync(repoScripts, { recursive: true });
    fs.writeFileSync(path.join(repoScripts, 'forge-example.js'), 'source of truth\n');

    const legacy = path.join(data.root, '.claude', 'scripts');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.symlinkSync(repoScripts, legacy, process.platform === 'win32' ? 'junction' : 'dir');

    const backupRoot = path.join(data.root, 'backup');
    const plan = [];
    installer.retireLegacyScripts(legacy, backupRoot, plan, {}, {
      inventory: new Set(['forge-example.js']),
      settingsFiles: [],
      repo,
    });

    const skipped = plan.find((entry) => entry.op === 'skip' && entry.reason === 'symlinked-to-source-repo');
    assert(skipped, 'esperava um skip explicando que o legado aponta pro repo-fonte');
    assert.strictEqual(
      fs.readFileSync(path.join(repoScripts, 'forge-example.js'), 'utf8'),
      'source of truth\n',
      'o arquivo do repo nunca pode ser movido através do symlink',
    );
    assert.strictEqual(fs.existsSync(path.join(backupRoot, 'legacy', 'claude-scripts', 'forge-example.js')), false);
  } finally { data.cleanup(); }
});

test('retireLegacyScripts refuses ANY symlinked legacy dir — the remote-checkout flow that bit twice', () => {
  // The first guard compared the link target against context.repo and was
  // inert in the flow that actually caused the damage: a remote --update runs
  // from a TEMPORARY release checkout, so context.repo is the tmpdir and the
  // dev repo the link points into reads as "outside". Measured live, twice:
  // v4.25.0 and v4.25.1 each retired 446 of the dev repo's own scripts/*
  // through the ~/.claude/scripts symlink. A symlink is never OUR legacy copy
  // — skip, whatever it points at.
  const data = fixture();
  try {
    const devRepoScripts = path.join(data.root, 'DevRepo', 'scripts');
    fs.mkdirSync(devRepoScripts, { recursive: true });
    fs.writeFileSync(path.join(devRepoScripts, 'forge-example.js'), 'source of truth\n');

    const remoteCheckout = path.join(data.root, 'tmp-remote-checkout');
    fs.mkdirSync(remoteCheckout, { recursive: true });

    const legacy = path.join(data.root, '.claude', 'scripts');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.symlinkSync(devRepoScripts, legacy, process.platform === 'win32' ? 'junction' : 'dir');

    const backupRoot = path.join(data.root, 'backup');
    const plan = [];
    installer.retireLegacyScripts(legacy, backupRoot, plan, {}, {
      inventory: new Set(['forge-example.js']),
      settingsFiles: [],
      repo: remoteCheckout, // the installing repo is NOT the link target
    });

    const skipped = plan.find((entry) => entry.op === 'skip' && entry.reason === 'symlinked-not-a-copy');
    assert(skipped, 'esperava um skip: symlink nunca é cópia legada, aponte para onde apontar');
    assert.strictEqual(skipped.link_target, fs.realpathSync(devRepoScripts), 'o plano registra o alvo real do link');
    assert.strictEqual(
      fs.readFileSync(path.join(devRepoScripts, 'forge-example.js'), 'utf8'),
      'source of truth\n',
      'os arquivos do repo de dev nunca podem ser movidos através do symlink',
    );
    assert.strictEqual(fs.existsSync(path.join(backupRoot, 'legacy', 'claude-scripts', 'forge-example.js')), false);

    // Sem context.repo nenhum (installs antigos): mesma recusa, mesma razão genérica.
    const planNoRepo = [];
    installer.retireLegacyScripts(legacy, backupRoot, planNoRepo, {}, {
      inventory: new Set(['forge-example.js']),
      settingsFiles: [],
    });
    assert(planNoRepo.find((e) => e.op === 'skip' && e.reason === 'symlinked-not-a-copy'),
      'sem context.repo a recusa continua — o guard não depende de saber quem instala');
  } finally { data.cleanup(); }
});

test('classification: name, inventory and orphan — every leg proven capable of the other verdict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-classify-Ω-'));
  try {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    for (const [relative, body] of [
      ['forge-hook.js', 'x'], ['merge-settings.js', 'x'], ['operator.py', 'x'],
      ['sub/forge-runs.js', 'x'], ['sub/notes.txt', 'x'], [installer.TOMBSTONE, 'tombstone'],
    ]) fs.writeFileSync(path.join(root, relative.split('/').join(path.sep)), body);

    const withInventory = installer.classifyLegacyScripts(root, new Set(['merge-settings.js']));
    assert.deepStrictEqual(withInventory.managed, ['forge-hook.js', 'merge-settings.js', 'sub/forge-runs.js']);
    assert.deepStrictEqual(withInventory.retained, ['operator.py', 'sub/notes.txt']);
    assert(!withInventory.managed.includes(installer.TOMBSTONE) && !withInventory.retained.includes(installer.TOMBSTONE),
      'o tombstone entrou na classificação — ele não é conteúdo, é a lápide');

    // Control: drop the inventory and `merge-settings.js` becomes a stranger. The
    // second leg is doing real work, not decorating the name rule.
    const nameOnly = installer.classifyLegacyScripts(root, new Set());
    assert(nameOnly.retained.includes('merge-settings.js'),
      'controle: sem inventário, um arquivo nosso sem prefixo deveria cair em retained');
    assert(nameOnly.managed.includes('forge-hook.js'), 'controle: a regra de nome parou de morder');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the settings scan sees every separator form and invents nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-refscan-Ω-'));
  try {
    const settings = path.join(root, 'settings.json');
    // A Windows absolute path as it really appears in JSON: separators escaped.
    fs.writeFileSync(settings, `${JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'python C:\\Users\\dev\\.claude\\scripts\\svn-session-reconcile.py' }] }] },
    }, null, 2)}\n`);
    const hits = installer.legacyScriptReferences([settings], ['svn-session-reconcile.py', 'nunca-referenciado.js']);
    assert.deepStrictEqual(hits.map((item) => item.script), ['svn-session-reconcile.py'],
      'a varredura não vê o separador escapado do Windows, ou inventou uma referência');
    assert.deepStrictEqual(installer.legacyScriptReferences([path.join(root, 'ausente.json')], ['x.js']), [],
      'um settings.json ausente precisa ser silêncio, não exceção');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Claude 3.1.4 fixture preserves JSONC, Markdown, hooks and project .gsd on update', () => {
  const data = fixture();
  try {
    fs.mkdirSync(path.join(data.claudeHome, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(data.claudeHome, 'legacy', '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(data.claudeHome, 'forge-agent-prefs.jsonc'), '{\r\n  "legacy": true, // preserved\r\n}\r\n');
    fs.writeFileSync(path.join(data.claudeHome, 'forge-agent-prefs.md'), '# Legacy prefs\r\n');
    fs.writeFileSync(path.join(data.claudeHome, 'hooks', 'user-hook.js'), 'module.exports = true;\r\n');
    fs.writeFileSync(path.join(data.claudeHome, 'legacy', '.gsd', 'STATE.md'), 'project state\r\n');
    installer.install({ ...data.options, runtime: 'claude' });
    const before = {
      prefs: fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc')),
      md: fs.readFileSync(path.join(data.claudeHome, 'forge-agent-prefs.md')),
      hook: fs.readFileSync(path.join(data.claudeHome, 'hooks', 'user-hook.js')),
      state: fs.readFileSync(path.join(data.claudeHome, 'legacy', '.gsd', 'STATE.md')),
    };
    installer.install({ ...data.options, runtime: 'claude', update: true });
    assert.deepStrictEqual(fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc')), before.prefs);
    assert.deepStrictEqual(fs.readFileSync(path.join(data.claudeHome, 'forge-agent-prefs.md')), before.md);
    assert.deepStrictEqual(fs.readFileSync(path.join(data.claudeHome, 'hooks', 'user-hook.js')), before.hook);
    assert.deepStrictEqual(fs.readFileSync(path.join(data.claudeHome, 'legacy', '.gsd', 'STATE.md')), before.state);
  } finally { data.cleanup(); }
});

test('capability diagnostics remain selected-host local and offline', () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-installer-cli-Ω-'));
  const fake = path.join(fakeRoot, 'fake.js');
  fs.writeFileSync(fake, "if (process.argv.includes('--version')) process.stdout.write('3.2.0\\n'); else if (process.argv.includes('--help')) process.stdout.write('ok\\n');");
  try {
    const report = capabilities.detect(path.resolve(__dirname, '..'), { runtime: 'codex', binaries: { codex: { command: process.execPath, args: [fake] }, claude: path.join(fakeRoot, 'absent') } });
    assert.strictEqual(report.probes.codex.status, 'available');
    assert.strictEqual(report.probes.claude.reason_code, 'not-selected');
  } finally { fs.rmSync(fakeRoot, { recursive: true, force: true }); }
});

test('selected runtime capability failure is fail-closed before writes', () => {
  const data = fixture();
  try {
    assert.throws(() => installer.install({ ...data.options, skipCapabilityCheck: false, runtime: 'codex', binaries: { codex: path.join(data.root, 'missing-codex') } }), /capability obrigatória/);
    assert.strictEqual(fs.existsSync(data.forgeHome), false);
  } finally { data.cleanup(); }
});

test('--no-model-probe bypasses the local capability gate explicitly', () => {
  const data = fixture();
  try {
    const report = installer.install({ ...data.options, skipCapabilityCheck: false, runtime: 'claude', noModelProbe: true, binaries: { claude: path.join(data.root, 'missing-claude') } });
    assert.strictEqual(report.capabilities, null);
    assert.strictEqual(report.ok, true);
  } finally { data.cleanup(); }
});

test('Claude 3.1.4 fixture is versioned with prefs, Markdown, hooks, templates and .gsd', () => {
  const fixtureRoot = path.join(__dirname, 'fixtures', 'installer', 'claude-3.1.4');
  for (const relative of ['forge-agent-prefs.jsonc', 'forge-agent-prefs.md', 'hooks/user-hook.js', 'templates/dispatch/execute-task.md', '.gsd/STATE.md']) {
    assert.strictEqual(fs.existsSync(path.join(fixtureRoot, relative)), true, `missing fixture ${relative}`);
  }
  assert.match(fs.readFileSync(path.join(fixtureRoot, 'forge-agent-prefs.jsonc'), 'utf8'), /fixture_version/);
});

// ── The summary names what it left behind ───────────────────────────────────
// A bare "Conflicts preserved: N" is why this drift stays invisible: the
// operator learns that N destinations were skipped but not WHICH, so a stale
// file on the hook execution path reads exactly like a stale file nobody loads.
// Measured: an `--update` that reported success left ~/.claude/forge-hook.js
// frozen several releases back, and finding it took a byte-compare against repo
// history instead of reading the summary.
test('preserved conflicts are named, not just counted', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });

    // Make two destinations conflict for the two DIFFERENT reasons the summary
    // distinguishes: an unmarked legacy projection, and the operator-owned file.
    const legacy = path.join(data.claudeHome, 'forge-prefs.schema.json');
    fs.writeFileSync(legacy, '{"editado":true}\n', 'utf8');
    const settings = path.join(data.claudeHome, 'settings.json');
    fs.writeFileSync(settings, '{"hooks":{}}\n', 'utf8');

    const report = installer.install({ ...data.options, runtime: 'claude', update: true });
    const text = installer.render(report);

    // Positive control first: the counts still exist, so the asserts below are
    // about naming and not about a summary that lost its conflict section.
    assert.match(text, /Conflicts preserved: \d+/, 'a linha de contagem sumiu do resumo');
    assert.match(text, /Operator-owned preserved: \d+/, 'a linha de operator-owned sumiu do resumo');

    assert.ok(text.includes(`  [preserved] ${legacy}`),
      `o resumo não nomeou a projeção legada preservada:\n${text}`);
    assert.ok(text.includes(`  [operator-owned] ${settings}`),
      `o resumo não nomeou o arquivo do operador preservado:\n${text}`);

    // Every named line must point at a real path — a label with no destination
    // would be the anonymous count wearing a different shape.
    for (const line of text.split('\n')) {
      const named = /^ {2}\[(?:preserved|operator-owned)\] (.+)$/.exec(line);
      if (named) assert.ok(path.isAbsolute(named[1]), `caminho não absoluto no resumo: ${line}`);
    }
  } finally { data.cleanup(); }
});

// The renderer owns the ownership BEHAVIOR; the installer owns its PERSISTENCE.
// A record that is not carried across runs is no record at all — every JSON
// projection would re-freeze on the next update, which is the defect this
// closes, reintroduced one layer up.
test('the ownership record is persisted in the manifest and survives a second run', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    const manifestPath = path.join(data.forgeHome, 'manifest.json');
    const first = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.ok(first.ownership && typeof first.ownership === 'object', 'manifesto não persistiu o registro de propriedade');
    const schemaDest = path.join(data.claudeHome, 'forge-prefs.schema.json');
    assert.ok(first.ownership[path.resolve(schemaDest)],
      'o destino JSON — o que não pode carregar marcador — ficou de fora do registro');
    for (const [file, sha] of Object.entries(first.ownership)) {
      assert.ok(path.isAbsolute(file), `chave do registro não é caminho absoluto: ${file}`);
      assert.match(sha, /^[0-9a-f]{64}$/, `digest malformado para ${file}`);
    }

    const second = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    installer.install({ ...data.options, runtime: 'claude', update: true });
    const third = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(third.ownership[path.resolve(schemaDest)],
      'o registro do destino JSON sumiu no update — ele volta a congelar na execução seguinte');
    assert.strictEqual(third.ownership[path.resolve(schemaDest)], second.ownership[path.resolve(schemaDest)],
      'o digest mudou sem que o conteúdo mudasse');
  } finally { data.cleanup(); }
});

// Held by TWO independent mechanisms — the renderer spreads the record it was
// given into the one it returns, and the installer merges over the prior
// manifest. Removing either alone keeps this green; removing both turns it red
// (verified). Kept as a property test rather than split into two line-level
// asserts: what matters is that a Codex destination survives a Claude-only run,
// not which of the two layers happened to carry it.
test('a single-runtime run merges the record instead of replacing it', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'both' });
    const manifestPath = path.join(data.forgeHome, 'manifest.json');
    const both = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const codexEntries = Object.keys(both.ownership).filter((file) => file.startsWith(path.resolve(data.codexHome)));
    assert.ok(codexEntries.length > 0, 'controle: a instalação both não registrou nenhum destino do Codex');

    installer.install({ ...data.options, runtime: 'claude', update: true });
    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const file of codexEntries) {
      assert.ok(after.ownership[file],
        `um run --runtime claude derrubou o registro do Codex (${file}) — a próxima instalação Codex trataria tudo como estranho`);
    }
  } finally { data.cleanup(); }
});

// ── The exit out of a freeze is visible in the manifest and in the summary ───
//
// Rung 4 (digest) is unreachable for a destination that was already divergent
// when it shipped: `recordOf` records what a run WROTE, and a `user_owned`
// destination is what a run does not write. Rung 5 reads the source repo's
// history instead. Here the resolver is INJECTED — this suite is about the
// installer's reporting and persistence, not about git; the history behavior has
// its own suite (forge-projection-provenance.test.js) with real repos.
test('an adopted destination is named in the summary and recorded in the manifest', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    const frozen = path.join(data.claudeHome, 'forge-prefs.schema.json');
    const edited = path.join(data.claudeHome, 'forge-capabilities.json');
    fs.writeFileSync(frozen, '{"release":"antiga"}\n', 'utf8');  // ours, at some past release
    fs.writeFileSync(edited, '{"meu":true}\n', 'utf8');          // genuinely the operator's

    // The resolver answers only for the frozen file; everything else degrades to a
    // named reason, exactly as a real run without history would.
    const provenance = {
      digestsFor: (source) => (source === 'forge-prefs.schema.json'
        ? new Set([require('./forge-projection-ownership.js').digest('{"release":"antiga"}\n')])
        : new Set()),
      verdictFor: (source, content) => (source === 'forge-prefs.schema.json'
        ? { matched: true, reason: 'release-match', revisions: 7, truncated: false }
        : { matched: false, reason: 'operator-edit', revisions: 4, truncated: false }),
    };

    const report = installer.install({ ...data.options, runtime: 'claude', update: true, provenance });
    const claude = report.manifest.adapters.claude;
    assert(claude.adopted.includes(frozen), `a adoção não foi registrada no manifesto: ${JSON.stringify(claude.adopted)}`);
    assert(!claude.conflicts.some((item) => item.destination === frozen), 'o adotado continuou listado como conflito');
    const conflict = claude.conflicts.find((item) => item.destination === edited);
    assert(conflict, 'a edição real do operador deixou de ser conflito');
    assert.strictEqual(conflict.provenance, 'operator-edit');
    assert.strictEqual(fs.readFileSync(edited, 'utf8'), '{"meu":true}\n', 'os bytes do operador foram sobrescritos');

    const text = installer.render(report);
    assert(text.includes(`  [adopted] ${frozen}`), `o resumo não nomeia o que foi adotado:\n${text}`);
    assert.match(text, /Adopted from release history: \d+/, 'a linha de adoção sumiu do resumo');
    assert(text.includes(`  [preserved] ${edited} (proveniência: operator-edit)`),
      `o preservado não diz em que base foi preservado:\n${text}`);
  } finally { data.cleanup(); }
});

test('a clean update names nothing — the section is absent, not empty', () => {
  const data = fixture();
  try {
    installer.install({ ...data.options, runtime: 'claude' });
    const text = installer.render(installer.install({ ...data.options, runtime: 'claude', update: true }));
    assert.ok(!/\[preserved\]/.test(text), 'resumo listou preservados num update sem conflito');
  } finally { data.cleanup(); }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
