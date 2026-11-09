#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveForgeHome } = require('./forge-home');
const { git } = require('./forge-git-process');
const { compareSemver, parseStableTags } = require('./forge-update-remote');

const TTL_MS = 600000;
const REFRESH_TIMEOUT_MS = 60000;
const MAX_FILE_BYTES = 65536;
const MAX_REMOTE_LENGTH = 2048;
const MAX_PATH_LENGTH = 4096;
const CACHE_SCHEMA_VERSION = 2;
const SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f-\x9f]/;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonicalPath(value) {
  let identity = path.resolve(value);
  try { identity = fs.realpathSync.native(identity); } catch (_) { /* path may not exist yet */ }
  return process.platform === 'win32' ? identity.toLowerCase() : identity;
}

function renderContext(target, options = {}) {
  if (typeof target === 'string') {
    return { mode: 'clone', repo: canonicalPath(target), cwd: canonicalPath(target), direct: true };
  }
  const input = target && typeof target === 'object' ? target : {};
  const cwd = path.resolve(input.cwd || options.cwd || process.cwd());
  const forgeHome = resolveForgeHome({
    forgeHome: input.forgeHome || options.forgeHome,
    userHome: input.userHome || options.userHome,
    env: input.env || options.env || process.env,
    platform: input.platform || options.platform,
  });
  const prefs = input.prefs && typeof input.prefs === 'object' ? input.prefs : {};
  return { mode: 'installation', forgeHome: canonicalPath(forgeHome), cwd, prefsRepo: resolveRepoPath(prefs, cwd) };
}

function cachePath(target, directory = path.join(os.tmpdir(), `forge-update-cache-${digest(os.homedir()).slice(0, 24)}`)) {
  const context = renderContext(target);
  const identity = context.mode === 'installation'
    ? `installation\0${context.forgeHome}`
    : `clone\0${context.repo}`;
  return path.join(directory, `forge-update-${digest(identity)}.json`);
}

function ensureCacheDirectory(file) {
  const directory = path.dirname(file);
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Unsafe update cache directory');
  }
}

function readPrivateFile(file, maxBytes = MAX_FILE_BYTES) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('Unsafe update data file');
  }
  return fs.readFileSync(file, 'utf8');
}

function readJsonFile(file) {
  return JSON.parse(readPrivateFile(file, MAX_FILE_BYTES));
}

function publish(file, contents) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, contents, 'utf8'); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally {
    if (created) { try { fs.unlinkSync(temporary); } catch (_) { /* already renamed */ } }
  }
}

function safeText(value, limit = 256) {
  return typeof value === 'string' && value.length <= limit && !CONTROL_PATTERN.test(value);
}

function readGeneration(file) {
  try {
    const generation = readPrivateFile(`${file}.generation`, 64);
    if (!/^[a-f0-9-]{36}$/.test(generation)) throw new Error('Invalid update cache generation');
    return generation;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readCache(file) {
  try {
    const value = readJsonFile(file);
    const valid = value && typeof value === 'object' && !Array.isArray(value)
      && value.schema_version === CACHE_SCHEMA_VERSION
      && Number.isFinite(value.ts) && value.ts >= 0
      && typeof value.has_update === 'boolean'
      && ['unknown', 'equal', 'behind', 'ahead', 'diverged', 'differs'].includes(value.state)
      && ['remote', 'clone', 'invalid'].includes(value.source_mode)
      && /^[a-f0-9]{64}$/.test(value.identity)
      && safeText(value.version) && safeText(value.remote_version)
      && (value.localCommit == null || SHA_PATTERN.test(value.localCommit))
      && (value.remoteCommit == null || SHA_PATTERN.test(value.remoteCommit))
      && (value.error == null || safeText(value.error, 64))
      && (value.generation == null || /^[a-f0-9-]{36}$/.test(value.generation));
    return valid && (value.generation || null) === readGeneration(file) ? value : null;
  } catch (_) { return null; }
}

function resolveRepoPath(prefs, cwd = process.cwd()) {
  const repo = prefs && typeof prefs.repo_path === 'string' ? prefs.repo_path.trim() : '';
  return repo ? path.resolve(cwd, repo) : null;
}

function validateString(value, label, limit, options = {}) {
  if (typeof value !== 'string' || !value || value.length > limit || CONTROL_PATTERN.test(value)) {
    throw new Error(`invalid_${label}`);
  }
  if (options.rejectOption && value.startsWith('-')) throw new Error(`invalid_${label}`);
  return value;
}

function installationVersion(manifest, remote) {
  if (remote && remote.channel === 'stable') return remote.tag;
  const version = validateString(manifest.version, 'version', 64);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('invalid_version');
  return version;
}

function validateRemoteSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_source_remote');
  const remote = validateString(value.remote, 'remote', MAX_REMOTE_LENGTH, { rejectOption: true });
  const channel = validateString(value.channel, 'channel', 16);
  if (channel !== 'stable' && channel !== 'master') throw new Error('invalid_channel');
  const sha = validateString(value.sha, 'sha', 64);
  if (!SHA_PATTERN.test(sha)) throw new Error('invalid_sha');
  let tag = value.tag;
  if (channel === 'stable') {
    tag = validateString(tag, 'tag', 64);
    if (!STABLE_TAG_PATTERN.test(tag)) throw new Error('stable_invalid_tag');
  } else if (tag !== null && tag !== undefined) {
    throw new Error('master_invalid_tag');
  }
  return { remote, channel, sha, tag: tag || null };
}

function validateRepo(value, base) {
  const repo = validateString(value, 'source_repo', MAX_PATH_LENGTH, { rejectOption: true });
  return path.resolve(base, repo);
}

function resolveInstalledSource(target, options = {}) {
  const context = renderContext(target, options);
  if (context.mode === 'clone') return { mode: 'clone', repo: context.repo, version: null, direct: true };
  const manifest = readJsonFile(path.join(context.forgeHome, 'manifest.json'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('invalid_manifest');
  if (Object.prototype.hasOwnProperty.call(manifest, 'source_remote')) {
    const remote = validateRemoteSource(manifest.source_remote);
    return { mode: 'remote', ...remote, version: installationVersion(manifest, remote), forgeHome: context.forgeHome };
  }
  const repoValue = typeof manifest.source_repo === 'string' && manifest.source_repo.trim()
    ? manifest.source_repo.trim()
    : context.prefsRepo;
  if (!repoValue) throw new Error('source_unavailable');
  const repo = validateRepo(repoValue, context.cwd);
  return { mode: 'clone', repo, version: installationVersion(manifest), forgeHome: context.forgeHome };
}

function sourceIdentity(source, localCommit = null) {
  if (source.mode === 'remote') {
    return digest(JSON.stringify({ mode: 'remote', remote: source.remote, channel: source.channel,
      tag: source.tag, sha: source.sha, version: source.version }));
  }
  return digest(JSON.stringify({ mode: 'clone', repo: canonicalPath(source.repo), version: source.version,
    localCommit: localCommit || null }));
}

function unknownResult(identity = digest('invalid-installation'), error = 'update-check-unavailable', generation = null) {
  return { schema_version: CACHE_SCHEMA_VERSION, ts: Date.now(), state: 'unknown', source_mode: 'invalid',
    identity, version: '', has_update: false, remote_version: '', error, generation };
}

function diagnosticCode(error) {
  const message = error && error.message;
  // Only our symbolic validation/state codes may cross the refresh boundary.
  // Native Git errors can contain the complete command, including a remote URL
  // with embedded credentials, so arbitrary exception text is never cached.
  return typeof message === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(message)
    ? message
    : 'update-check-unavailable';
}

function invalidateCache(target, options = {}) {
  const file = cachePath(target, options.cacheDir);
  ensureCacheDirectory(file);
  publish(`${file}.generation`, crypto.randomUUID());
  try {
    fs.unlinkSync(file);
    return { invalidated: true, file };
  } catch (error) {
    if (error.code === 'ENOENT') return { invalidated: false, reason: 'cache-missing', file };
    throw error;
  }
}

function compareCommits(repo, local, remote, runGit = git) {
  if (!SHA_PATTERN.test(local) || !SHA_PATTERN.test(remote)) return 'unknown';
  if (local === remote) return 'equal';
  const ancestor = (left, right) => {
    try { runGit(repo, ['merge-base', '--is-ancestor', left, right], { timeout: 2000 }); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  try {
    if (ancestor(local, remote)) return 'behind';
    if (ancestor(remote, local)) return 'ahead';
    return 'diverged';
  } catch (_) { return 'unknown'; }
}

function remoteRefresh(source, generation, runGit) {
  const cwd = source.forgeHome;
  const identity = sourceIdentity(source);
  if (source.channel === 'stable') {
    const tags = parseStableTags(runGit(cwd, ['ls-remote', '--tags', source.remote], { timeout: 5000 }));
    const installed = tags.find((entry) => `v${entry.version}` === source.tag);
    if (!installed || installed.sha !== source.sha) throw new Error('stable_retarget_or_missing');
    if (!tags.length) throw new Error('stable_tags_unavailable');
    const latest = tags[0];
    const currentVersion = source.tag.slice(1);
    const hasUpdate = compareSemver(latest.version, currentVersion) > 0;
    return { schema_version: CACHE_SCHEMA_VERSION, ts: Date.now(), last_success_ts: Date.now(),
      source_mode: 'remote', identity, version: source.tag, localCommit: source.sha,
      remoteCommit: latest.sha, state: hasUpdate ? 'behind' : 'equal', has_update: hasUpdate,
      remote_version: hasUpdate ? `v${latest.version}` : '', generation };
  }
  const output = String(runGit(cwd, ['ls-remote', source.remote, 'refs/heads/master'], { timeout: 5000 })).trim();
  const match = /^([a-f0-9]{40,64})\s+refs\/heads\/master$/.exec(output);
  if (!match) throw new Error('master_ref_unavailable');
  const remoteCommit = match[1];
  const differs = remoteCommit !== source.sha;
  return { schema_version: CACHE_SCHEMA_VERSION, ts: Date.now(), last_success_ts: Date.now(),
    source_mode: 'remote', identity, version: source.version, localCommit: source.sha, remoteCommit,
    state: differs ? 'differs' : 'equal', has_update: differs,
    remote_version: differs ? remoteCommit.slice(0, 8) : '', generation };
}

function cloneRefresh(source, generation, runGit) {
  const repo = source.repo;
  const localCommit = String(runGit(repo, ['rev-parse', '--verify', 'HEAD'], { timeout: 2000 })).trim();
  if (!SHA_PATTERN.test(localCommit)) throw new Error('local_commit_unavailable');
  const identity = sourceIdentity(source, localCommit);
  const remoteCommit = String(runGit(repo, ['ls-remote', 'origin', 'HEAD'], { timeout: 5000 })).trim().split(/\s+/)[0];
  if (!SHA_PATTERN.test(remoteCommit)) throw new Error('remote_head_unavailable');
  try { runGit(repo, ['cat-file', '-e', `${remoteCommit}^{commit}`], { timeout: 2000 }); }
  catch (_) { runGit(repo, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', remoteCommit], { timeout: 5000 }); }
  const state = compareCommits(repo, localCommit, remoteCommit, runGit);
  if (state === 'unknown') throw new Error('ancestry_unavailable');
  const hasUpdate = state === 'behind' || state === 'diverged';
  let remoteVersion = '';
  if (hasUpdate) {
    try {
      const tags = parseStableTags(runGit(repo, ['ls-remote', '--tags', 'origin'], { timeout: 5000 }));
      const tag = tags.find((entry) => entry.sha === remoteCommit);
      remoteVersion = tag ? `v${tag.version}` : remoteCommit.slice(0, 8);
    } catch (_) { remoteVersion = remoteCommit.slice(0, 8); }
  }
  let version = source.version;
  if (!version) {
    version = localCommit.slice(0, 8);
    try { version = String(runGit(repo, ['describe', '--tags', '--always'], { timeout: 2000 })).trim().replace(/^(v[\d.]+)-(\d+)-g[0-9a-f]+$/, '$1.$2'); }
    catch (_) { /* direct legacy clone only */ }
  }
  return { schema_version: CACHE_SCHEMA_VERSION, ts: Date.now(), last_success_ts: Date.now(),
    source_mode: 'clone', identity, version, localCommit, remoteCommit, state,
    has_update: hasUpdate, remote_version: remoteVersion, generation };
}

// Runs only in the bounded refresh subprocess, never on the render path.
function refresh(target, options = {}) {
  const file = cachePath(target, options.cacheDir);
  ensureCacheDirectory(file);
  const generation = readGeneration(file);
  const runGit = options.git || git;
  let next;
  try {
    const source = resolveInstalledSource(target, options);
    next = source.mode === 'remote'
      ? remoteRefresh(source, generation, runGit)
      : cloneRefresh(source, generation, runGit);
  } catch (error) {
    next = unknownResult(digest(`invalid\0${renderContext(target, options).mode}`), diagnosticCode(error), generation);
  }
  publish(file, JSON.stringify(next));
  return next;
}

function spawnRequest(context) {
  if (context.mode === 'clone') return { repo: context.repo };
  return { forgeHome: context.forgeHome, cwd: context.cwd, prefsRepo: context.prefsRepo };
}

function targetFromRequest(request) {
  if (request && typeof request.repo === 'string') return request.repo;
  return { forgeHome: request && request.forgeHome, cwd: request && request.cwd,
    prefs: request && request.prefsRepo ? { repo_path: request.prefsRepo } : {} };
}

function cachedUpdate(target, options = {}) {
  const context = renderContext(target, options);
  const file = cachePath(target, options.cacheDir);
  const unknown = { state: 'unknown', version: '', has_update: false, remote_version: '' };
  try { ensureCacheDirectory(file); } catch (_) { return unknown; }
  const cache = readCache(file);
  if (!cache || Date.now() - cache.ts >= TTL_MS) {
    const marker = `${file}.refresh`;
    try {
      try { if (Date.now() - fs.statSync(marker).mtimeMs > REFRESH_TIMEOUT_MS) fs.unlinkSync(marker); } catch (_) { /* absent */ }
      const fd = fs.openSync(marker, 'wx', 0o600);
      fs.closeSync(fd);
      const launch = options.spawn || spawn;
      try {
        const request = Buffer.from(JSON.stringify(spawnRequest(context))).toString('base64url');
        const child = launch(process.execPath, [__filename, '--refresh', request, path.dirname(file)],
          { stdio: 'ignore', windowsHide: true, detached: true });
        child.on('error', () => { try { fs.unlinkSync(marker); } catch (_) { /* best effort */ } });
        child.unref();
      } catch (_) { try { fs.unlinkSync(marker); } catch (_) { /* best effort */ } }
    } catch (_) { /* another renderer already scheduled the refresh */ }
  }
  return cache || unknown;
}

function decodeRequest(value) {
  const text = Buffer.from(String(value || ''), 'base64url').toString('utf8');
  if (text.length > MAX_FILE_BYTES) throw new Error('invalid refresh request');
  const request = JSON.parse(text);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid refresh request');
  return request;
}

if (require.main === module && process.argv[2] === '--refresh') {
  let target;
  try {
    target = targetFromRequest(decodeRequest(process.argv[3]));
    refresh(target, { cacheDir: process.argv[4] });
  } finally {
    try {
      if (target) fs.unlinkSync(`${cachePath(target, process.argv[4])}.refresh`);
    } catch (_) { /* best effort */ }
  }
}

if (require.main === module && process.argv[2] === '--invalidate') {
  try {
    let target;
    let cacheDir;
    if (process.argv[3] === '--cwd') {
      if (!process.argv[4]) throw new Error('--cwd requires a consumer directory');
      target = { cwd: path.resolve(process.argv[4]), prefs: {} };
      cacheDir = process.argv[5];
    } else if (process.argv[3]) {
      target = process.argv[3];
      cacheDir = process.argv[4];
    } else throw new Error('--invalidate requires a repository path or --cwd <consumer>');
    console.log(JSON.stringify(invalidateCache(target, { cacheDir })));
  } catch (error) {
    console.error(safeText(error && error.message, 256) ? error.message : 'update cache invalidation failed');
    process.exitCode = 1;
  }
}

module.exports = {
  cachePath,
  resolveRepoPath,
  resolveInstalledSource,
  invalidateCache,
  compareCommits,
  refresh,
  cachedUpdate,
  TTL_MS,
  _private: {
    CACHE_SCHEMA_VERSION,
    CONTROL_PATTERN,
    MAX_FILE_BYTES,
    MAX_REMOTE_LENGTH,
    SHA_PATTERN,
    STABLE_TAG_PATTERN,
    readCache,
    sourceIdentity,
    validateRemoteSource,
  },
};
