#!/usr/bin/env node
'use strict';

// Remote bootstrap for forge-update. The installed updater must never point its
// old in-process installer at a newer tree: that would copy new files while
// stamping the old VERSION and rendering with old code. Instead, pin a remote
// commit, materialize it in a temporary directory, then execute that checkout's
// updater in the explicit local-source mode.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_REMOTE = 'https://github.com/vh2224/forge-agent.git';
const DEFAULT_CHANNEL = 'stable';
const DEFAULT_BRANCH = 'master';
const MAX_BUFFER = 64 * 1024 * 1024;
const REQUIRED_SOURCE_FILES = Object.freeze([
  'forge-source-manifest.json',
  'scripts/forge-update.js',
  'scripts/forge-installer.js',
  'scripts/forge-version.js',
]);

function compareSemver(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function validateRemote(remote, options = {}) {
  const value = String(remote || DEFAULT_REMOTE).trim();
  if (options.allowLocalRemote) return value;
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('remote inválido: use uma URL HTTPS explícita'); }
  if (parsed.protocol !== 'https:') throw new Error('remote inseguro: somente HTTPS é aceito');
  if (parsed.username || parsed.password) throw new Error('remote inseguro: credenciais não podem estar embutidas na URL');
  return value;
}

function runGit(runner, args, options = {}) {
  const result = runner('git', args, { encoding: 'utf8', shell: false, maxBuffer: MAX_BUFFER, ...options });
  if (!result || result.status !== 0) {
    const detail = result && (result.stderr || (result.error && result.error.message));
    throw new Error(`git ${args[0]} falhou${detail ? `: ${String(detail).trim()}` : ''}`);
  }
  return String(result.stdout || '');
}

function parseStableTags(output) {
  const tags = new Map();
  for (const raw of String(output || '').split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,64})\s+refs\/tags\/v(\d+\.\d+\.\d+)(\^\{\})?$/.exec(raw.trim());
    if (!match) continue;
    const [, sha, version, peeled] = match;
    const current = tags.get(version) || {};
    if (peeled) current.commit = sha;
    else current.direct = sha;
    tags.set(version, current);
  }
  return [...tags.entries()]
    .map(([version, value]) => ({ version, sha: value.commit || value.direct }))
    .filter((entry) => entry.sha)
    .sort((a, b) => compareSemver(b.version, a.version));
}

function resolveRemote(input = {}, dependencies = {}) {
  const runner = dependencies.runner || spawnSync;
  const remote = validateRemote(input.remote || DEFAULT_REMOTE, { allowLocalRemote: dependencies.allowLocalRemote === true });
  const channel = input.channel || DEFAULT_CHANNEL;
  if (!['stable', 'master'].includes(channel)) throw new Error(`canal remoto inválido: ${JSON.stringify(channel)} (use stable ou master)`);
  if (channel === 'stable') {
    const tags = parseStableTags(runGit(runner, ['ls-remote', '--tags', remote]));
    if (!tags.length) throw new Error(`remote sem release estável semver: ${remote}`);
    const latest = tags[0];
    return { remote, channel, ref: `refs/tags/v${latest.version}`, checkout: `v${latest.version}`, tag: `v${latest.version}`, version: latest.version, sha: latest.sha };
  }
  const ref = `refs/heads/${DEFAULT_BRANCH}`;
  const line = runGit(runner, ['ls-remote', remote, ref]).trim();
  const match = /^([0-9a-f]{40,64})\s+refs\/heads\/master$/.exec(line);
  if (!match) throw new Error(`branch remota ausente: ${ref}`);
  return { remote, channel, ref, checkout: DEFAULT_BRANCH, tag: null, version: null, sha: match[1] };
}

/**
 * The version the REMOTE CHECKOUT declares — asked of the checkout, not guessed
 * from its bytes.
 *
 * Reading `const VERSION = '<semver>'` with a regex only ever worked for the
 * releases that carried a literal. Measured against the published v4.21.0: the
 * release line resolves VERSION dynamically (`installedVersion() ||
 * sourceVersion() || archiveVersion() || FALLBACK_VERSION`), the regex matches
 * nothing, and the whole remote update aborted with "fonte remota sem VERSION
 * semver válido" — against the very tag it is supposed to install.
 *
 * So the literal is tried first (cheap, and it executes nothing for the older
 * releases that still carry one), and only when there is no literal does the
 * checkout's own module compute the answer in a subprocess. That subprocess runs
 * AFTER the manifest has been validated and immediately before we execute that
 * same checkout's updater, so it introduces no trust boundary that the bootstrap
 * did not already cross. The module path travels as argv, never interpolated
 * into evaluated source.
 */
function declaredVersion(repo, runner = spawnSync) {
  const file = path.join(repo, 'scripts', 'forge-version.js');
  const source = fs.readFileSync(file, 'utf8');
  const literal = /const\s+VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(source);
  if (literal) return literal[1];
  const probe = runner(process.execPath, ['-p', 'require(process.argv[1]).VERSION', file], {
    cwd: repo, encoding: 'utf8', shell: false, maxBuffer: MAX_BUFFER,
  });
  if (!probe || probe.status !== 0) {
    const detail = probe && (probe.stderr || (probe.error && probe.error.message));
    throw new Error(`fonte remota não declara VERSION${detail ? `: ${String(detail).trim().split(/\r?\n/)[0]}` : ''}`);
  }
  const value = String(probe.stdout || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`fonte remota sem VERSION semver válido: ${JSON.stringify(value)}`);
  return value;
}

function safeManifestPath(value) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)
      || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value)) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  return !segments.includes('..') && !segments.includes('');
}

function validateSourceManifest(manifest) {
  if (!manifest || manifest.schema_version !== '1.0.0' || !Array.isArray(manifest.sources) || !manifest.sources.length) {
    throw new Error('manifesto remoto incompatível: esperado schema_version 1.0.0 com sources[] não vazio');
  }
  for (const source of manifest.sources) {
    const inputs = source && source.inputs;
    const targets = source && source.render_targets;
    if (!source || typeof source.source_id !== 'string' || !source.source_id.trim()
        || !Array.isArray(inputs) || !inputs.length || !inputs.every(safeManifestPath)
        || !Array.isArray(targets) || !targets.length
        || !targets.every((target) => target && safeManifestPath(target.path))) {
      throw new Error(`manifesto remoto incompatível: source inválido ${JSON.stringify(source && source.source_id)}`);
    }
  }
  return manifest;
}

function validateMaterializedSource(repo, resolved, runner = spawnSync) {
  for (const relative of REQUIRED_SOURCE_FILES) {
    if (!fs.existsSync(path.join(repo, relative))) throw new Error(`fonte remota incompleta: ausente ${relative}`);
  }
  const head = runGit(runner, ['-C', repo, 'rev-parse', 'HEAD']).trim();
  if (head !== resolved.sha) throw new Error(`fonte remota mudou durante o update: esperado ${resolved.sha}, obtido ${head}`);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(repo, 'forge-source-manifest.json'), 'utf8')); }
  catch (error) { throw new Error(`manifesto remoto inválido: ${error.message}`); }
  validateSourceManifest(manifest);
  const version = declaredVersion(repo, runner);
  if (resolved.version !== null && resolved.version !== version) {
    throw new Error(`VERSION remota ${version} difere da tag estável ${resolved.version}`);
  }
  return { ...resolved, path: repo, declared_version: version, version_matches_ref: resolved.version === null ? null : true };
}

function materializeRemoteSource(input = {}, dependencies = {}) {
  const runner = dependencies.runner || spawnSync;
  const resolved = resolveRemote(input, dependencies);
  const parent = dependencies.tempParent || os.tmpdir();
  const temporary = fs.mkdtempSync(path.join(parent, 'forge-update-remote-'));
  const repo = path.join(temporary, 'source');
  let retained = false;
  try {
    // Full history on purpose — `--depth 1` is what a bandwidth-minded reading
    // would reach for, and it makes the checkout unusable. The release line
    // refuses a shallow repository by contract: `forge-release-version.js`
    // throws `version-history-incomplete` ("fetch full history and tags before
    // installing or packaging") the moment `forge-version.js` is required, so a
    // shallow clone of the real v4.21.0 cannot report its own version, and the
    // updater we are about to run inside it dies on require. Measured on a
    // local shallow clone of that tag; the full clone is ~8 MB and works.
    runGit(runner, ['clone', '--quiet', '--single-branch', '--branch', resolved.checkout, resolved.remote, repo]);
    const source = validateMaterializedSource(repo, resolved, runner);
    retained = true;
    return {
      ...source,
      temporary,
      cleanup() { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 }); },
    };
  } finally {
    if (!retained) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}

function pushFlag(args, flag, value) {
  if (value === undefined || value === null || value === '') return;
  args.push(flag, String(value));
}

function bootstrapArgs(source, input = {}) {
  const args = [path.join(source.path, 'scripts', 'forge-update.js'), '--source', 'local', '--repo', source.path, input.apply ? '--apply' : '--dry-run', '--json'];
  pushFlag(args, '--runtime', input.runtime);
  pushFlag(args, '--forge-home', input.forgeHome);
  pushFlag(args, '--claude-home', input.claudeHome);
  pushFlag(args, '--codex-home', input.codexHome);
  pushFlag(args, '--project-root', input.projectRoot);
  pushFlag(args, '--capability-timeout', input.capabilityTimeout);
  if (input.noModelProbe) args.push('--no-model-probe');
  if (input.migrateLegacy) args.push('--migrate-legacy');
  if (input.withApp) args.push('--with-app');
  return args;
}

/**
 * Does the checkout we just materialized understand `--source local`?
 *
 * It is the newer flag, so every tag published before this change refuses it at
 * argument parsing. Measured against the real v4.21.0: the bootstrap died with
 * `opção desconhecida: --source` — the remote update could not install the very
 * release the server was serving. Probed through `--help`, which every release
 * answers, rather than by pattern-matching the remote file's bytes or by reading
 * an error string back out of a failed run.
 */
function supportsSourceMode(source, runner = spawnSync) {
  const result = runner(process.execPath, [path.join(source.path, 'scripts', 'forge-update.js'), '--help'], {
    cwd: source.path, encoding: 'utf8', shell: false, maxBuffer: MAX_BUFFER,
  });
  if (!result || result.status !== 0) return false;
  return /--source local/.test(String(result.stdout || ''));
}

/**
 * The bridge for releases that predate `--source local`: run the REMOTE
 * checkout's own installer against itself.
 *
 * This keeps the property the whole module exists for — the bytes installed, the
 * VERSION stamped and the code doing the rendering all come from the pinned
 * server revision, never from a local clone. The only thing lost is the
 * structured JSON report, so the remote installer's own output is carried
 * through verbatim instead of being summarized into silence.
 *
 * The runtime is resolved from the LOCAL manifest and passed explicitly. That is
 * load-bearing, not tidiness: the published installer defaults `--runtime` to
 * `claude`, so omitting it would convert a Codex-only installation to Claude —
 * exactly the implicit conversion this product forbids.
 */
function compatInstallerArgs(source, input = {}, runtime) {
  const args = [path.join(source.path, 'scripts', 'forge-installer.js'), '--repo', source.path, '--update', '--runtime', String(runtime)];
  if (!input.apply) args.push('--dry-run');
  pushFlag(args, '--forge-home', input.forgeHome);
  pushFlag(args, '--claude-home', input.claudeHome);
  pushFlag(args, '--codex-home', input.codexHome);
  pushFlag(args, '--project-root', input.projectRoot);
  pushFlag(args, '--capability-timeout', input.capabilityTimeout);
  if (input.noModelProbe) args.push('--no-model-probe');
  if (input.migrateLegacy) args.push('--migrate-legacy');
  if (input.withApp) args.push('--with-app');
  return args;
}

function normalizeCompatManifest(forgeHome, provenance, io = fs) {
  const manifestFile = path.join(forgeHome, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(io.readFileSync(manifestFile, 'utf8')); }
  catch (error) { throw new Error(`bootstrap remoto (compat) não pôde normalizar manifest.json: ${error.message}`); }
  const normalized = { ...manifest, source_remote: { ...provenance } };
  delete normalized.source_repo;
  const temporary = `${manifestFile}.tmp-${process.pid}-${Date.now()}`;
  try {
    io.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    io.renameSync(temporary, manifestFile);
  } catch (error) {
    try { io.rmSync(temporary, { force: true }); } catch (_) { /* best effort */ }
    throw new Error(`bootstrap remoto (compat) não pôde normalizar manifest.json: ${error.message}`);
  }
  return normalized;
}

function runCompatBootstrap(source, input, dependencies, provenance) {
  const runner = dependencies.runner || spawnSync;
  const planUpdate = dependencies.planUpdate || require('./forge-maintenance.js').planUpdate;
  const plan = planUpdate(input);
  const result = runner(process.execPath, compatInstallerArgs(source, input, plan.runtime), {
    cwd: input.cwd || process.cwd(), encoding: 'utf8', shell: false, maxBuffer: MAX_BUFFER,
  });
  const output = `${(result && result.stdout) || ''}${(result && result.stderr) || ''}`;
  if (!result || result.status !== 0) {
    const detail = output.trim() || (result && result.error && result.error.message);
    throw new Error(`bootstrap remoto (compat) falhou${detail ? `: ${String(detail).trim()}` : ''}`);
  }
  const manifest = input.apply
    ? normalizeCompatManifest(plan.forge_home, provenance, dependencies.fs || fs)
    : null;
  return {
    ...plan,
    source_repo: null,
    remote_source: provenance,
    applied: Boolean(input.apply),
    ...(manifest ? { manifest } : {}),
    // Named, never implied: this path has no structured plan, so it must not
    // present an empty `retirements` array as "nothing was retired".
    bootstrap: {
      mode: 'installer-compat',
      reason: 'a release remota antecede `--source local`; o instalador dela foi executado sobre o próprio checkout',
      runtime_source: input.runtime ? 'flag' : 'manifest',
      exit_code: 0,
      output,
    },
  };
}

function runBootstrappedUpdate(source, input = {}, dependencies = {}) {
  const runner = dependencies.runner || spawnSync;
  const provenance = { remote: source.remote, channel: source.channel, ref: source.ref, tag: source.tag, sha: source.sha, declared_version: source.declared_version, version_matches_ref: source.version_matches_ref };
  if (!supportsSourceMode(source, runner)) return runCompatBootstrap(source, input, dependencies, provenance);
  const result = runner(process.execPath, bootstrapArgs(source, input), {
    cwd: input.cwd || process.cwd(),
    encoding: 'utf8',
    shell: false,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, FORGE_UPDATE_REMOTE_PROVENANCE: JSON.stringify(provenance) },
  });
  if (!result || result.status !== 0) {
    const detail = result && (result.stderr || result.stdout || (result.error && result.error.message));
    throw new Error(`bootstrap remoto falhou${detail ? `: ${String(detail).trim()}` : ''}`);
  }
  let report;
  try { report = JSON.parse(String(result.stdout || '')); }
  catch (error) { throw new Error(`bootstrap remoto retornou JSON inválido: ${error.message}`); }
  return { ...report, remote_source: provenance };
}

function updateFromRemote(input = {}, dependencies = {}) {
  const source = materializeRemoteSource(input, dependencies);
  try { return runBootstrappedUpdate(source, input, dependencies); }
  finally { source.cleanup(); }
}

module.exports = {
  DEFAULT_REMOTE,
  DEFAULT_CHANNEL,
  DEFAULT_BRANCH,
  REQUIRED_SOURCE_FILES,
  compareSemver,
  validateRemote,
  parseStableTags,
  resolveRemote,
  declaredVersion,
  safeManifestPath,
  validateSourceManifest,
  validateMaterializedSource,
  materializeRemoteSource,
  bootstrapArgs,
  supportsSourceMode,
  compatInstallerArgs,
  normalizeCompatManifest,
  runCompatBootstrap,
  runBootstrappedUpdate,
  updateFromRemote,
};
