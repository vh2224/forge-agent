#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Installed BEFORE the modules under test are required, because
// forge-capabilities destructures spawnSync at require time. While armed, every
// spawn is recorded so a test can prove a probe did NOT happen instead of
// granting itself skipCapabilityCheck (which would prove nothing about the CLI).
const childProcess = require('child_process');
const realSpawnSync = childProcess.spawnSync;
let spawnLog = null;
childProcess.spawnSync = function guardedSpawnSync(command, args, options) {
  if (spawnLog) {
    spawnLog.push(`${command} ${Array.isArray(args) ? args.join(' ') : ''}`.trim());
    // `git` is allowed through and still recorded. Reading the source clone's own
    // state (`rev-parse`, `status`, `rev-list`) is not a probe of an external
    // runtime: no network, no writes — and the preview is exactly where an
    // operator needs to learn the clone is stale before applying anything. Every
    // other command stays denied, so the assertion below still proves no
    // `claude`/`codex --version` happened, and the recorded log is checked to
    // prove the git calls were read-only.
    if (command !== 'git') throw new Error(`spawn denied while previewing: ${command}`);
  }
  return realSpawnSync.call(this, command, args, options);
};

const installer = require('./forge-installer.js');
const updater = require('./forge-update.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-'));
  return { root, userHome: root, forgeHome: path.join(root, 'forge'), claudeHome: path.join(root, 'claude'), codexHome: path.join(root, 'codex'), projectRoot: path.join(root, 'project'), repo: path.resolve(__dirname, '..'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function snapshot(root) {
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else entries.push([path.relative(root, file), fs.readFileSync(file).toString('hex')]);
    }
  };
  visit(root);
  return entries;
}

test('codex-only apply preserves prefs/config and does not create Claude home', () => {
  const data = fixture();
  try {
    const base = { ...data, runtime: 'codex', skipCapabilityCheck: true };
    delete base.root; delete base.cleanup;
    installer.install(base);
    const prefs = path.join(data.forgeHome, 'forge-agent-prefs.jsonc');
    const config = path.join(data.codexHome, 'operator-config.toml');
    fs.writeFileSync(prefs, '{"operator":true}\n');
    fs.writeFileSync(config, 'operator = true\n');
    const report = updater.update({ ...base, apply: true });
    assert.strictEqual(report.runtime, 'codex');
    assert(report.backup && fs.existsSync(report.backup));
    assert.strictEqual(fs.readFileSync(prefs, 'utf8'), '{"operator":true}\n');
    assert.strictEqual(fs.readFileSync(config, 'utf8'), 'operator = true\n');
    assert.strictEqual(fs.existsSync(data.claudeHome), false);
  } finally { data.cleanup(); }
});

test('legacy Claude 3.1.4 migration preserves source bytes and reports provenance', () => {
  const data = fixture();
  try {
    fs.mkdirSync(data.claudeHome, { recursive: true });
    const legacy = path.join(data.claudeHome, 'forge-agent-prefs.jsonc');
    const bytes = Buffer.from('{\r\n  "release": "3.1.4" // keep\r\n}\r\n');
    fs.writeFileSync(legacy, bytes);
    const report = updater.update({ ...data, runtime: 'claude', apply: true, skipCapabilityCheck: true });
    assert.strictEqual(report.legacy_migration.release, '3.1.4-compatible');
    assert(report.backup && fs.existsSync(report.backup), 'legacy update must create a rollback backup');
    assert.deepStrictEqual(fs.readFileSync(legacy), bytes);
    assert.deepStrictEqual(fs.readFileSync(path.join(data.forgeHome, 'forge-agent-prefs.jsonc')), bytes);
  } finally { data.cleanup(); }
});

// The fossil in these fixtures is named `forge-fossil.js` on purpose. It used to
// be `fossil.js` — a name Forge cannot prove is its own — and the assertion that
// it got moved encoded exactly the defect this suite now guards against:
// retirement renamed the whole directory, taking the operator's own scripts with
// it. Retiring a fossil is the intent; retiring a stranger never was.
test('dry-run lists legacy retire without changing a byte', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'forge-fossil.js'), 'legacy bytes\n');
    const before = snapshot(data.root);
    const report = updater.update({ ...data, runtime: 'claude', skipCapabilityCheck: true });
    assert.strictEqual(report.applied, false);
    const retire = report.retirements.find((entry) => entry.op === 'retire');
    assert(retire, 'dry-run must list retire');
    assert.strictEqual(retire.source, legacyScripts);
    assert.match(retire.destination, /forge[\\/]backups[\\/]/);
    assert.deepStrictEqual(snapshot(data.root), before, 'dry-run must leave the complete fixture byte-identical');
    assert.strictEqual(fs.existsSync(retire.destination), false);
    const output = updater.render(report);
    assert(output.includes(`retire: ${retire.source} -> ${retire.destination}`), 'dry-run output must list retire source and destination');
  } finally { data.cleanup(); }
});

test('dry-run plans retire without capability probing on the CLI path (no skip flag)', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'forge-fossil.js'), 'legacy bytes\n');
    const before = snapshot(data.root);
    const spawns = [];
    let report;
    spawnLog = spawns;
    // Exactly what `forge-update.js --dry-run` builds: parseArgs never sets
    // skipCapabilityCheck or noModelProbe, so neither is passed here.
    try { report = updater.update({ ...data, runtime: 'claude' }); } finally { spawnLog = null; }
    const probes = spawns.filter((entry) => !entry.startsWith('git '));
    assert.deepStrictEqual(probes, [], `dry-run must not spawn a capability probe; spawned: ${probes.join(', ')}`);
    // What the preview IS allowed to spawn, it must spawn read-only: describing the
    // source clone must never mutate it.
    for (const entry of spawns) {
      assert.match(entry, /^git\b.*\b(?:rev-parse|status|rev-list)\b/, `preview spawned a git that is not a read: ${entry}`);
    }
    assert.strictEqual(report.applied, false);
    assert(report.retirements.find((entry) => entry.op === 'retire'), 'dry-run must still list retire');
    assert.deepStrictEqual(snapshot(data.root), before, 'dry-run must leave the fixture byte-identical');
  } finally { data.cleanup(); }
});

test('apply retires legacy scripts and a second update reports skipped', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'forge-fossil.js'), 'legacy bytes\n');
    const first = updater.update({ ...data, runtime: 'claude', apply: true, skipCapabilityCheck: true });
    const retire = first.installer.plan.find((entry) => entry.op === 'retire');
    assert(retire && fs.existsSync(path.join(retire.destination, 'forge-fossil.js')));
    assert.strictEqual(fs.existsSync(path.join(legacyScripts, 'forge-fossil.js')), false);
    assert(fs.existsSync(path.join(legacyScripts, 'README.md')), 'apply writes a tombstone');
    const second = updater.update({ ...data, runtime: 'claude', skipCapabilityCheck: true });
    const skipped = second.retirements.find((entry) => entry.op === 'skip' && entry.reason === 'already-retired');
    assert(skipped, 'second update must report skipped retirement');
    assert.strictEqual(skipped.source, legacyScripts);
    assert.match(skipped.destination, /forge[\\/]backups[\\/]/);
  } finally { data.cleanup(); }
});

// The operator running `/forge-update` reads THIS output, not the installer's.
// A hook aimed inside the retired directory has to be visible here or the loss
// is silent exactly where it was silent before.
test('the update output names what was retained and warns about hooks aimed inside the retired directory', () => {
  const data = fixture();
  try {
    const legacyScripts = path.join(data.userHome, '.claude', 'scripts');
    fs.mkdirSync(legacyScripts, { recursive: true });
    fs.writeFileSync(path.join(legacyScripts, 'forge-fossil.js'), 'legacy bytes\n');
    fs.writeFileSync(path.join(legacyScripts, 'svn-session-reconcile.py'), 'print(1)\n');
    fs.writeFileSync(path.join(data.userHome, '.claude', 'settings.json'), `${JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'python ~/.claude/scripts/svn-session-reconcile.py', timeout: 45 }] }] },
    }, null, 2)}\n`);

    const report = updater.update({ ...data, runtime: 'claude', apply: true, skipCapabilityCheck: true });
    const output = updater.render(report);
    assert(output.includes('moved: 1; retained: 1'), `o resumo do update não contabiliza os dois lados:\n${output}`);
    assert(output.includes('[retained] svn-session-reconcile.py'), `o resumo do update não nomeia o que ficou:\n${output}`);
    assert(/⚠.*svn-session-reconcile\.py.*preservado no lugar/.test(output), `o hook do operador não foi mencionado:\n${output}`);
    assert.strictEqual(fs.readFileSync(path.join(legacyScripts, 'svn-session-reconcile.py'), 'utf8'), 'print(1)\n',
      'o script do operador não sobreviveu ao update');
  } finally { data.cleanup(); }
});

// ── The source repo is resolved, not assumed ────────────────────────────────
//
// `commands/forge-update.md` documents `node scripts/forge-update.js --apply
// --json`. Because `scripts/` is managed core, that command is routinely run
// from the INSTALLED copy under `~/.forge-agent/scripts/`, where `__dirname/..`
// is the Forge home — a directory that will never hold
// forge-source-manifest.json, since the installer does not copy it there. The
// documented command died on a raw ENOENT naming exactly that absent file.
// Measured on a real 4.8.0 → 4.15.0 update and reproduced on 4.15.0 itself.

test('apply resolves the source repo from recorded provenance — the documented command needs no --repo', () => {
  const data = fixture();
  try {
    const base = { ...data, runtime: 'claude', skipCapabilityCheck: true };
    delete base.root; delete base.cleanup;
    installer.install(base);

    const manifestFile = path.join(data.forgeHome, 'manifest.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).source_repo, data.repo,
      'a instalação não registrou de qual clone ela veio — não há o que resolver depois');

    // Control: the fixture only exercises provenance if the entry point really
    // cannot render on its own.
    assert.strictEqual(fs.existsSync(path.join(data.forgeHome, updater.SOURCE_MANIFEST)), false,
      'controle: o Forge home não pode conter o manifesto de origem');

    const fromHome = { ...base, apply: true, entryRoot: data.forgeHome };
    delete fromHome.repo;
    const report = updater.update(fromHome);
    assert.strictEqual(report.source_repo.origin, 'manifest');
    assert.strictEqual(report.source_repo.path, data.repo);
    assert.strictEqual(report.applied, true);
    assert(updater.render(report).includes(`source repo: ${data.repo} (manifest)`),
      'o resumo não nomeia o clone que foi lido nem como ele foi encontrado');
  } finally { data.cleanup(); }
});

test('without provenance and without --repo the failure names the flag, not ENOENT', () => {
  const data = fixture();
  try {
    const base = { ...data, runtime: 'claude', skipCapabilityCheck: true };
    delete base.root; delete base.cleanup;
    installer.install(base);

    // An installation made by any release before provenance was recorded.
    const manifestFile = path.join(data.forgeHome, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    delete manifest.source_repo;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    const blind = { ...base, apply: true, entryRoot: data.forgeHome };
    delete blind.repo;
    const before = snapshot(data.root);
    assert.throws(() => updater.update(blind), (error) => {
      assert.match(error.message, /--repo/, 'a mensagem não nomeia a flag que resolve o problema');
      assert.match(error.message, /forge-source-manifest\.json/, 'a mensagem não diz o que faltou');
      assert.doesNotMatch(error.message, /ENOENT/, 'continua sendo o ENOENT cru');
      assert.ok(error.message.includes(data.forgeHome), 'a mensagem não diz qual caminho foi avaliado');
      return true;
    });
    assert.deepStrictEqual(snapshot(data.root), before,
      'a resolução falhou DEPOIS de escrever — ela precisa acontecer antes do installer, sem backup órfão');
  } finally { data.cleanup(); }
});

test('precedence: an explicit --repo wins over provenance, and the entry point wins over both', () => {
  const data = fixture();
  try {
    const base = { ...data, runtime: 'claude', skipCapabilityCheck: true };
    delete base.root; delete base.cleanup;
    installer.install(base);

    const manifestFile = path.join(data.forgeHome, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.source_repo = path.join(data.root, 'clone-que-nao-existe');
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

    // Explicit flag: used as given, and the stale recorded value is not consulted.
    const explicit = updater.resolveSourceRepo({ ...base, repo: data.repo });
    assert.strictEqual(explicit.origin, 'flag');
    assert.strictEqual(explicit.path, data.repo);
    assert.deepStrictEqual(explicit.considered.map((item) => item.origin), ['flag'],
      'a flag explícita não deve nem avaliar a proveniência gravada');

    // No flag, and the entry point IS a clone (a developer running from the repo):
    // it wins without reading the manifest value at all.
    const fromRepo = { ...base, entryRoot: data.repo };
    delete fromRepo.repo;
    assert.strictEqual(updater.resolveSourceRepo(fromRepo).origin, 'entry');
  } finally { data.cleanup(); }
});

// ── The update says which bytes it is about to install ──────────────────────
//
// `/forge-update` reinstalls WHATEVER IS IN THE CLONE and never fetches. Measured:
// a clone 113 commits behind (4.8.0 against 4.15.0 at the tip) "updated"
// successfully to the same version, with no signal of it in the JSON or the
// summary — the operator had to run `git fetch` by hand to find out.

function git(root, args) {
  const result = realSpawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error}`);
  return result.stdout;
}

const gitProbe = realSpawnSync('git', ['--version'], { encoding: 'utf8', shell: false });
if (!gitProbe || gitProbe.status !== 0) {
  process.stdout.write('  ~ SKIP proveniência do clone: git indisponível; nada foi provado sobre sha/distância\n');
} else {
  test('the report carries the clone version, sha, dirtiness and distance from its tracking ref', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-source-repo-'));
    try {
      const origin = path.join(root, 'origin.git');
      const clone = path.join(root, 'clone');
      const other = path.join(root, 'other');
      realSpawnSync('git', ['init', '-q', '--bare', origin], { encoding: 'utf8', shell: false });

      realSpawnSync('git', ['clone', '-q', origin, clone], { encoding: 'utf8', shell: false });
      git(clone, ['config', 'user.email', 'forge@test.invalid']);
      git(clone, ['config', 'user.name', 'Forge Test']);
      git(clone, ['config', 'commit.gpgsign', 'false']);
      fs.mkdirSync(path.join(clone, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(clone, 'scripts', 'forge-version.js'), "const VERSION = '4.8.0';\n");
      git(clone, ['add', '-A']);
      git(clone, ['commit', '-q', '-m', 'v4.8.0']);
      git(clone, ['push', '-q', 'origin', 'HEAD']);
      // The branch name comes from the host's init.defaultBranch (master on CI,
      // main on any machine that set it) — hardcoding origin/master made this
      // suite fail deterministically on init.defaultBranch=main hosts.
      const defaultBranch = git(clone, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      git(clone, ['branch', '--set-upstream-to', `origin/${defaultBranch}`]);

      const atTip = updater.describeSourceRepo(clone);
      assert.strictEqual(atTip.vcs, 'git');
      assert.strictEqual(atTip.version, '4.8.0', 'a versão lida é a do clone, não a do código que está rodando');
      assert.match(atTip.sha, /^[0-9a-f]{7,}$/);
      assert.strictEqual(atTip.dirty, false);
      assert.strictEqual(atTip.behind_tracking, 0);

      // Someone else advances the remote. Until this clone FETCHES, the number is
      // still 0 — and that is the honest answer, because it is measured on the
      // local remote-tracking ref and this function never contacts a server.
      realSpawnSync('git', ['clone', '-q', origin, other], { encoding: 'utf8', shell: false });
      git(other, ['config', 'user.email', 'forge@test.invalid']);
      git(other, ['config', 'user.name', 'Forge Test']);
      git(other, ['config', 'commit.gpgsign', 'false']);
      fs.writeFileSync(path.join(other, 'scripts', 'forge-version.js'), "const VERSION = '4.15.0';\n");
      git(other, ['add', '-A']);
      git(other, ['commit', '-q', '-m', 'v4.15.0']);
      git(other, ['push', '-q', 'origin', 'HEAD']);

      assert.strictEqual(updater.describeSourceRepo(clone).behind_tracking, 0,
        'a distância veio de algum lugar que não o ref local — este número não pode falar do servidor');

      git(clone, ['fetch', '-q', 'origin']);
      const behind = updater.describeSourceRepo(clone);
      assert.strictEqual(behind.behind_tracking, 1, 'depois do fetch a distância precisa aparecer');
      assert.strictEqual(behind.tracking_ref, `origin/${defaultBranch}`);
      assert.strictEqual(behind.version, '4.8.0', 'o clone continua em 4.8.0 — é isso que um update instalaria');

      fs.writeFileSync(path.join(clone, 'sujo.txt'), 'x\n');
      assert.strictEqual(updater.describeSourceRepo(clone).dirty, true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('a source repo without git degrades by name instead of pretending to know', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-source-nogit-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'forge-version.js'), "const VERSION = '9.9.9';\n");
    const described = updater.describeSourceRepo(root);
    assert.strictEqual(described.vcs, 'none');
    assert.strictEqual(described.version, '9.9.9', 'a versão declarada não depende de git');
    assert.strictEqual(described.sha, null);
    assert.strictEqual(described.behind_tracking, null, 'sem git a distância tem de ser null, nunca 0');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the summary always says that refreshing the clone is a separate step', () => {
  const data = fixture();
  try {
    const report = updater.update({ ...data, runtime: 'claude', skipCapabilityCheck: true });
    const output = updater.render(report);
    assert(output.includes('atualizar o clone (`git fetch` + `git pull`) é passo separado'),
      `o resumo não avisa que o clone não é atualizado por este comando:\n${output}`);
    // The JSON path carries the same facts as fields, not as prose.
    for (const key of ['path', 'origin', 'vcs', 'version', 'sha', 'dirty', 'tracking_ref', 'behind_tracking']) {
      assert(key in report.source_repo, `source_repo sem o campo ${key}`);
    }
  } finally { data.cleanup(); }
});

test('CLI defaults to the remote stable channel and local clones require explicit opt-in', () => {
  const defaults = updater.parseArgs([]);
  assert.strictEqual(defaults.source, 'remote');
  assert.strictEqual(defaults.channel, 'stable');
  assert.match(defaults.remote, /^https:\/\//);
  assert.throws(() => updater.parseArgs(['--repo', __dirname]), /--source local/);
  const local = updater.parseArgs(['--source', 'local', '--repo', path.resolve(__dirname, '..')]);
  assert.strictEqual(local.source, 'local');
  assert.strictEqual(local.repo, path.resolve(__dirname, '..'));
});

test('the projected command launches the installed updater instead of a cwd clone', () => {
  const command = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'commands', 'forge-update.md'), 'utf8');
  assert(command.includes("process.env.FORGE_HOME||p.join(o.homedir(),'.forge-agent')"));
  assert(command.includes("require(p.join(h,'scripts','forge-update.js')).run(process.argv.slice(1))"));
  assert(!/^node scripts\/forge-update\.js/m.test(command));
  assert(/Windows,\s*\nmacOS e Linux/.test(command));
});

test('a remote bootstrap records pinned server provenance instead of its disposable checkout', () => {
  const data = fixture();
  try {
    const provenance = {
      remote: 'https://github.com/vh2224/forge-agent.git', channel: 'stable',
      ref: 'refs/tags/v4.18.0', tag: 'v4.18.0', sha: 'a'.repeat(40),
      declared_version: '4.17.0', version_matches_ref: false,
    };
    const report = updater.update({ ...data, runtime: 'both', apply: true, skipCapabilityCheck: true, remoteProvenance: provenance });
    const manifest = JSON.parse(fs.readFileSync(path.join(data.forgeHome, 'manifest.json'), 'utf8'));
    assert.deepStrictEqual(manifest.source_remote, provenance);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(manifest, 'source_repo'), false,
      'the deleted temporary checkout must not become durable provenance');
    assert.deepStrictEqual(report.remote_source, provenance);
    const rendered = updater.render(report);
    assert(rendered.includes('clone local ignorado'));
    assert(rendered.includes('difere da tag'));
  } finally { data.cleanup(); }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
