#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const remote = require('./forge-update-remote.js');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error}`);
  return String(result.stdout || '').trim();
}
function writeSource(repo, version) {
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'forge-source-manifest.json'), `${JSON.stringify({
    schema_version: '1.0.0',
    sources: [{ source_id: 'fixture', inputs: ['scripts'], render_targets: [{ path: 'scripts', recursive: true }] }],
  })}\n`);
  fs.writeFileSync(path.join(repo, 'scripts', 'forge-version.js'), `const VERSION = '${version}';\n`);
  fs.writeFileSync(path.join(repo, 'scripts', 'forge-update.js'), '// fixture updater\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'forge-installer.js'), '// fixture installer\n');
}
function commit(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}
function fixtureRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-remote-test-'));
  const repo = path.join(root, 'server');
  fs.mkdirSync(repo);
  let init = spawnSync('git', ['init', '-q', '--initial-branch=master', repo], { encoding: 'utf8', shell: false });
  if (init.status !== 0) {
    init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', shell: false });
    if (init.status !== 0) throw new Error(init.stderr || 'git init failed');
    git(repo, ['checkout', '-q', '-B', 'master']);
  }
  git(repo, ['config', 'user.email', 'forge@test.invalid']);
  git(repo, ['config', 'user.name', 'Forge Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeSource(repo, '1.2.0'); commit(repo, '1.2.0'); git(repo, ['tag', 'v1.2.0']);
  writeSource(repo, '1.10.0'); const stableSha = commit(repo, '1.10.0'); git(repo, ['tag', 'v1.10.0']);
  writeSource(repo, '9.9.9'); const masterSha = commit(repo, 'master ahead');
  return { root, repo, stableSha, masterSha, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }) };
}

test('semver sorting chooses 1.10.0 over 1.2.0 and understands peeled tags', () => {
  const tags = remote.parseStableTags([
    `${'a'.repeat(40)}\trefs/tags/v1.2.0`,
    `${'b'.repeat(40)}\trefs/tags/v1.10.0`,
    `${'c'.repeat(40)}\trefs/tags/v1.10.0^{}`,
    `${'d'.repeat(40)}\trefs/tags/not-semver`,
  ].join('\n'));
  assert.deepStrictEqual(tags, [
    { version: '1.10.0', sha: 'c'.repeat(40) },
    { version: '1.2.0', sha: 'a'.repeat(40) },
  ]);
});

test('the default remote is HTTPS and credential-bearing/non-HTTPS URLs are refused', () => {
  assert.match(remote.validateRemote(), /^https:\/\//);
  assert.throws(() => remote.validateRemote('http://example.test/forge.git'), /somente HTTPS/);
  assert.throws(() => remote.validateRemote('https://user:token@example.test/forge.git'), /credenciais/);
  assert.throws(() => remote.validateRemote('C:\\clone'), /HTTPS/);
});

test('remote source manifests reject empty inventories and unsafe paths', () => {
  assert.throws(() => remote.validateSourceManifest({ schema_version: '1.0.0', sources: [] }), /não vazio/);
  assert.throws(() => remote.validateSourceManifest({
    schema_version: '1.0.0',
    sources: [{ source_id: 'escape', inputs: ['../outside'], render_targets: [{ path: 'scripts' }] }],
  }), /source inválido/);
});

test('stable materialization ignores master, pins the latest semver tag and cleans up', () => {
  const data = fixtureRemote();
  try {
    const source = remote.materializeRemoteSource({ remote: data.repo, channel: 'stable' }, { allowLocalRemote: true });
    const temporary = source.temporary;
    assert.strictEqual(source.tag, 'v1.10.0');
    assert.strictEqual(source.sha, data.stableSha);
    assert.strictEqual(source.declared_version, '1.10.0');
    assert.strictEqual(source.version_matches_ref, true);
    assert(fs.existsSync(source.path));
    // Behavioural, not an argv spelling check: the release line refuses a
    // shallow repository (`version-history-incomplete`), so a `--depth 1`
    // checkout of a real tag cannot even report its own version.
    assert.strictEqual(git(source.path, ['rev-parse', '--is-shallow-repository']), 'false',
      'the remote checkout is shallow; forge-version.js refuses to resolve there');
    source.cleanup();
    assert.strictEqual(fs.existsSync(temporary), false, 'temporary remote checkout was retained');
  } finally { data.cleanup(); }
});

test('stable tag and declared VERSION mismatch aborts before bootstrap and cleans up', () => {
  const data = fixtureRemote();
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-mismatch-'));
  const calls = [];
  try {
    git(data.repo, ['tag', '-f', 'v1.10.0', data.masterSha]);
    const runner = (command, args, options) => {
      calls.push({ command, args: [...args] });
      return spawnSync(command, args, options);
    };
    assert.throws(() => remote.updateFromRemote(
      { remote: data.repo, channel: 'stable' },
      { allowLocalRemote: true, tempParent, runner },
    ), /VERSION remota 9\.9\.9 difere da tag estável 1\.10\.0/);
    assert.strictEqual(calls.some(({ command, args }) => command === process.execPath
      && args.some((arg) => /forge-update\.js$/.test(arg))), false,
    'bootstrap executed despite the stable tag/VERSION mismatch');
    assert.deepStrictEqual(fs.readdirSync(tempParent), [], 'temporary checkout was retained after mismatch');
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true, maxRetries: 3 });
    data.cleanup();
  }
});

test('master channel pins the server head rather than any local clone or stable tag', () => {
  const data = fixtureRemote();
  try {
    const source = remote.materializeRemoteSource({ remote: data.repo, channel: 'master' }, { allowLocalRemote: true });
    assert.strictEqual(source.ref, 'refs/heads/master');
    assert.strictEqual(source.sha, data.masterSha);
    assert.strictEqual(source.declared_version, '9.9.9');
    assert.strictEqual(source.version_matches_ref, null);
    source.cleanup();
  } finally { data.cleanup(); }
});

test('a moved or substituted checkout is rejected before remote code executes', () => {
  const data = fixtureRemote();
  try {
    assert.throws(() => remote.validateMaterializedSource(data.repo, {
      remote: data.repo, channel: 'master', ref: 'refs/heads/master', sha: '0'.repeat(40), version: null,
    }), /mudou durante o update/);
  } finally { data.cleanup(); }
});

test('network/ref failure is loud and has no local-clone fallback', () => {
  const runner = () => ({ status: 1, stdout: '', stderr: 'offline fixture' });
  assert.throws(() => remote.resolveRemote({ remote: 'https://example.test/forge.git' }, { runner }), /git ls-remote falhou.*offline fixture/);
});

const BOOTSTRAP_SOURCE = {
  path: path.join(os.tmpdir(), 'forge remote source'), remote: remote.DEFAULT_REMOTE, channel: 'stable',
  ref: 'refs/tags/v5.0.0', tag: 'v5.0.0', sha: 'a'.repeat(40), declared_version: '5.0.0', version_matches_ref: true,
};
const MODERN_HELP = 'Usage: forge-update.js [...]\n       forge-update.js --source local --repo DIR\n';
const LEGACY_HELP = 'Usage: forge-update.js [--runtime claude|codex|both] [--apply|--dry-run] [--repo DIR] [--json]\n';

// One recorder for both bootstrap paths: `--help` decides which branch is taken,
// so the test that proves the branch must be the one that answers the probe.
function bootstrapRunner(calls, help) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('--help')) return { status: 0, stdout: help, stderr: '' };
    return { status: 0, stdout: JSON.stringify({ ok: true, applied: true }), stderr: '' };
  };
}

test('bootstrap executes the downloaded updater with argv, local mode and pinned provenance', () => {
  const calls = [];
  const report = remote.runBootstrappedUpdate(BOOTSTRAP_SOURCE, { apply: true, runtime: 'both', noModelProbe: true },
    { runner: bootstrapRunner(calls, MODERN_HELP) });
  assert.strictEqual(calls.length, 2, 'expected the --help capability probe followed by the bootstrap');
  const [probe, boot] = calls;
  assert(probe.args.includes('--help') && probe.args[0].endsWith(path.join('scripts', 'forge-update.js')));
  assert.strictEqual(boot.command, process.execPath);
  assert(boot.args.includes('--source') && boot.args.includes('local'));
  assert(boot.args.includes('--repo') && boot.args.includes(BOOTSTRAP_SOURCE.path));
  assert.strictEqual(boot.options.shell, false);
  const provenance = JSON.parse(boot.options.env.FORGE_UPDATE_REMOTE_PROVENANCE);
  assert.strictEqual(provenance.sha, BOOTSTRAP_SOURCE.sha);
  assert.strictEqual(report.remote_source.sha, BOOTSTRAP_SOURCE.sha);
});

// Every tag published before `--source local` existed refuses it at argument
// parsing — measured against the real v4.21.0, which died with
// `opção desconhecida: --source`. The bridge runs the REMOTE checkout's own
// installer, so the bytes still come from the pinned server revision.
test('a release predating --source local is bootstrapped through its own installer', () => {
  const calls = [];
  const planUpdate = () => ({ ok: true, runtime: 'codex', selected: ['codex'], installation_source: 'forge-manifest', backup_required: true });
  const report = remote.runCompatBootstrap(BOOTSTRAP_SOURCE, { apply: false, withApp: true },
    { runner: bootstrapRunner(calls, LEGACY_HELP), planUpdate }, { sha: BOOTSTRAP_SOURCE.sha });
  const boot = calls[calls.length - 1];
  assert(boot.args[0].endsWith(path.join('scripts', 'forge-installer.js')), 'compat path did not run the remote installer');
  assert(boot.args.includes('--repo') && boot.args.includes(BOOTSTRAP_SOURCE.path));
  assert(boot.args.includes('--update') && boot.args.includes('--dry-run') && boot.args.includes('--with-app'));
  assert.strictEqual(boot.options.shell, false);
  assert.strictEqual(report.bootstrap.mode, 'installer-compat');
  assert.strictEqual(report.applied, false);
  assert.strictEqual(report.remote_source.sha, BOOTSTRAP_SOURCE.sha);
  // The compat path reports no structured plan, so it must not present an empty
  // `retirements` array as proof that nothing was retired.
  assert.strictEqual(report.retirements, undefined);
});

// The published installer defaults `--runtime` to `claude`. Omitting it here is
// how a Codex-only installation silently becomes a Claude one.
test('the compat bootstrap always passes an explicit runtime resolved from the manifest', () => {
  const calls = [];
  const planUpdate = () => ({ ok: true, runtime: 'codex' });
  const report = remote.runCompatBootstrap(BOOTSTRAP_SOURCE, { apply: true },
    { runner: bootstrapRunner(calls, LEGACY_HELP), planUpdate }, {});
  const boot = calls[calls.length - 1];
  const runtimeIndex = boot.args.indexOf('--runtime');
  assert(runtimeIndex !== -1, 'no --runtime reached the legacy installer; it would default to claude');
  assert.strictEqual(boot.args[runtimeIndex + 1], 'codex');
  assert.strictEqual(boot.args.includes('--dry-run'), false, '--apply must not be previewed');
  assert.strictEqual(report.bootstrap.runtime_source, 'manifest');
});

test('runBootstrappedUpdate routes to the compat bridge when --help lacks --source local', () => {
  const calls = [];
  const planUpdate = () => ({ ok: true, runtime: 'claude' });
  const report = remote.runBootstrappedUpdate(BOOTSTRAP_SOURCE, { apply: false },
    { runner: bootstrapRunner(calls, LEGACY_HELP), planUpdate });
  assert.strictEqual(report.bootstrap.mode, 'installer-compat');
  assert(calls[1].args[0].endsWith(path.join('scripts', 'forge-installer.js')));
});

// A bootstrap that printed something other than a report must not be read as a
// successful update just because the process exited 0.
test('invalid bootstrap stdout is a failure, never a silent success', () => {
  const calls = [];
  const runner = (command, args) => {
    calls.push(args);
    if (args.includes('--help')) return { status: 0, stdout: MODERN_HELP, stderr: '' };
    return { status: 0, stdout: 'Instalado com sucesso!\n', stderr: '' };
  };
  assert.throws(() => remote.runBootstrappedUpdate(BOOTSTRAP_SOURCE, { apply: true }, { runner }), /JSON inválido/);
});

test('a non-zero bootstrap exit is reported, not summarized into a report', () => {
  const runner = (command, args) => (args.includes('--help')
    ? { status: 0, stdout: MODERN_HELP, stderr: '' }
    : { status: 1, stdout: '', stderr: 'disco cheio' });
  assert.throws(() => remote.runBootstrappedUpdate(BOOTSTRAP_SOURCE, { apply: true }, { runner }), /bootstrap remoto falhou.*disco cheio/);
});

// The temporary checkout is removed on the failure paths too — a remote update
// that aborts must not leave a full clone of the product in the temp directory.
test('a failing bootstrap still removes the temporary remote checkout', () => {
  const data = fixtureRemote();
  let temporary = null;
  try {
    const runner = (command, args, options) => {
      if (args[0] === 'clone' || args[0] === '-C' || args[0] === 'ls-remote') return spawnSync(command, args, options);
      if (args.includes('--help')) return { status: 0, stdout: MODERN_HELP, stderr: '' };
      return { status: 1, stdout: '', stderr: 'falha proposital' };
    };
    const deps = { runner, allowLocalRemote: true };
    const original = remote.materializeRemoteSource;
    assert.throws(() => {
      const source = original({ remote: data.repo, channel: 'stable' }, deps);
      temporary = source.temporary;
      try { return remote.runBootstrappedUpdate(source, { apply: true }, deps); }
      finally { source.cleanup(); }
    }, /bootstrap remoto falhou/);
    assert(temporary, 'the checkout was never materialized');
    assert.strictEqual(fs.existsSync(temporary), false, 'temporary remote checkout survived a failed bootstrap');
  } finally { data.cleanup(); }
});

// Every subprocess this module spawns goes through argv with the shell off. A
// remote-controlled string reaching a shell is the one failure mode that turns
// "install the newest release" into arbitrary execution.
test('no subprocess in this module is spawned through a shell', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-update-remote.js'), 'utf8');
  const spawns = source.match(/runner\(\s*(?:process\.execPath|command|'git')/g) || [];
  assert(spawns.length >= 4, `expected the module's spawn sites to be found, saw ${spawns.length}`);
  assert.strictEqual(/shell:\s*true/.test(source), false, 'a subprocess opted into a shell');
  const shellFalse = (source.match(/shell:\s*false/g) || []).length;
  assert(shellFalse >= spawns.length, `every spawn must set shell:false (${shellFalse} vs ${spawns.length} spawn sites)`);
});

// Since 4.19 the release line resolves VERSION dynamically, so the literal that
// the regex used to read is simply not there. Reading it back from the module
// itself is the only answer that survives both shapes.
test('declaredVersion reads a dynamically computed VERSION, not just a literal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-declared-version-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const file = path.join(root, 'scripts', 'forge-version.js');
    fs.writeFileSync(file, 'const parts = [4, 21, 0];\nconst VERSION = parts.join(".");\nmodule.exports = { VERSION };\n');
    assert.strictEqual(remote.declaredVersion(root), '4.21.0');
    fs.writeFileSync(file, 'module.exports = { VERSION: "not-semver" };\n');
    assert.throws(() => remote.declaredVersion(root), /sem VERSION semver válido/);
    fs.writeFileSync(file, 'throw new Error("version history incomplete");\n');
    assert.throws(() => remote.declaredVersion(root), /não declara VERSION/);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
