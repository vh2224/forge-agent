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
const TRANSIENT_RETRY_MS = 60000;
const MAX_FILE_BYTES = 65536;
const MAX_REMOTE_LENGTH = 2048;
const MAX_PATH_LENGTH = 4096;
const CACHE_SCHEMA_VERSION = 3;
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
  const cwd = canonicalPath(input.cwd || options.cwd || process.cwd());
  const forgeHome = resolveForgeHome({
    forgeHome: input.forgeHome || options.forgeHome,
    userHome: input.userHome || options.userHome,
    env: input.env || options.env || process.env,
    platform: input.platform || options.platform,
  });
  const prefs = input.prefs && typeof input.prefs === 'object' ? input.prefs : {};
  const explicitPrefsRepo = typeof input.prefsRepo === 'string' && input.prefsRepo.trim()
    ? canonicalPath(path.resolve(cwd, input.prefsRepo.trim()))
    : null;
  return {
    mode: 'installation',
    forgeHome: canonicalPath(forgeHome),
    cwd,
    prefsRepo: explicitPrefsRepo || resolveRepoPath(prefs, cwd),
  };
}

function cachePath(target, directory = path.join(os.tmpdir(), `forge-update-cache-${digest(os.homedir()).slice(0, 24)}`)) {
  const context = renderContext(target);
  const identity = context.mode === 'installation'
    ? JSON.stringify({ mode: context.mode, forgeHome: context.forgeHome, cwd: context.cwd,
      prefsRepo: context.prefsRepo || null })
    : JSON.stringify({ mode: context.mode, repo: context.repo });
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

function sameFile(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function validateBoundedFile(stat, maxBytes, policy) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(policy.error);
  }
  if (process.platform !== 'win32' && (stat.mode & policy.forbiddenMode)) {
    throw new Error(policy.error);
  }
  if (!policy.allowForeignOwner && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(policy.error);
  }
}

function readBoundedFile(file, maxBytes, policy) {
  const before = fs.lstatSync(file);
  validateBoundedFile(before, maxBytes, policy);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    validateBoundedFile(opened, maxBytes, policy);
    if (!sameFile(before, opened)) throw new Error(policy.error);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    validateBoundedFile(after, maxBytes, policy);
    if (!sameFile(opened, after) || length > maxBytes) throw new Error(policy.error);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readPrivateFile(file, maxBytes = MAX_FILE_BYTES) {
  return readBoundedFile(file, maxBytes, {
    allowForeignOwner: false,
    forbiddenMode: 0o077,
    error: 'Unsafe update data file',
  });
}

function readManifestFile(file) {
  return readBoundedFile(file, MAX_FILE_BYTES, {
    allowForeignOwner: true,
    forbiddenMode: 0o002,
    error: 'Unsafe update manifest',
  });
}

function readJsonFile(file) {
  return JSON.parse(readPrivateFile(file, MAX_FILE_BYTES));
}

function readManifest(file) {
  return JSON.parse(readManifestFile(file));
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
      && (value.last_success_ts == null || (Number.isFinite(value.last_success_ts) && value.last_success_ts >= 0))
      && (value.retry_after == null || (Number.isFinite(value.retry_after) && value.retry_after >= 0))
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
  return repo ? canonicalPath(path.resolve(cwd, repo)) : null;
}

function resolveConsumerContext(cwd, options = {}) {
  const consumer = canonicalPath(cwd || options.cwd || process.cwd());
  const readPrefs = options.readPrefs || require('./forge-prefs').readPrefsCached;
  const resolved = readPrefs(consumer, options.prefsOptions);
  if (!resolved || typeof resolved !== 'object') throw new Error('prefs_unavailable');
  return renderContext({
    cwd: consumer,
    forgeHome: options.forgeHome,
    userHome: options.userHome,
    env: options.env,
    platform: options.platform,
    prefs: resolved.prefs || {},
  });
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
  const remote = validateString(value.remote, 'remote', MAX_REMOTE_LENGTH).trim();
  if (!remote || remote.startsWith('-') || /^ext::/i.test(remote) || /--upload-pack/i.test(remote)) {
    throw new Error('invalid_remote');
  }
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
  const manifest = readManifest(path.join(context.forgeHome, 'manifest.json'));
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

function unknownResult(options = {}) {
  return {
    schema_version: CACHE_SCHEMA_VERSION,
    ts: Number.isFinite(options.ts) ? options.ts : Date.now(),
    last_success_ts: options.lastSuccessTs || null,
    retry_after: options.retryAfter || null,
    state: 'unknown',
    source_mode: options.sourceMode || 'invalid',
    identity: options.identity || digest('invalid-installation'),
    version: options.version || '',
    has_update: false,
    remote_version: '',
    error: options.error || 'update-check-unavailable',
    generation: options.generation || null,
  };
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

function callGit(runGit, cwd, args, options) {
  try {
    return runGit(cwd, args, options);
  } catch (cause) {
    const error = new Error('git_transient');
    error.transient = true;
    if (cause && Number.isInteger(cause.status)) error.status = cause.status;
    throw error;
  }
}

function successfulResult(fields) {
  const now = Date.now();
  return { schema_version: CACHE_SCHEMA_VERSION, ts: now, last_success_ts: now,
    retry_after: null, error: null, ...fields };
}

function invalidateCache(target, options = {}) {
  const context = renderContext(target, options);
  const file = cachePath(context, options.cacheDir);
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

function compareCommits(repo, local, remote, runGit = git, options = {}) {
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
  } catch (error) {
    if (options.throwOnError) throw error;
    return 'unknown';
  }
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
    return successfulResult({
      source_mode: 'remote', identity, version: source.tag, localCommit: source.sha,
      remoteCommit: latest.sha, state: hasUpdate ? 'behind' : 'equal', has_update: hasUpdate,
      remote_version: hasUpdate ? `v${latest.version}` : '', generation });
  }
  const output = String(runGit(cwd, ['ls-remote', source.remote, 'refs/heads/master'], { timeout: 5000 })).trim();
  const match = /^([a-f0-9]{40,64})\s+refs\/heads\/master$/.exec(output);
  if (!match) throw new Error('master_ref_unavailable');
  const remoteCommit = match[1];
  const differs = remoteCommit !== source.sha;
  return successfulResult({
    source_mode: 'remote', identity, version: source.version, localCommit: source.sha, remoteCommit,
    state: differs ? 'differs' : 'equal', has_update: differs,
    remote_version: differs ? remoteCommit.slice(0, 8) : '', generation });
}

function cloneRefresh(source, generation, runGit, prepared = {}) {
  const repo = source.repo;
  const localCommit = prepared.localCommit
    || String(runGit(repo, ['rev-parse', '--verify', 'HEAD'], { timeout: 2000 })).trim();
  if (!SHA_PATTERN.test(localCommit)) throw new Error('local_commit_unavailable');
  const identity = prepared.identity || sourceIdentity(source, localCommit);
  const remoteCommit = String(runGit(repo, ['ls-remote', 'origin', 'HEAD'], { timeout: 5000 })).trim().split(/\s+/)[0];
  if (!SHA_PATTERN.test(remoteCommit)) throw new Error('remote_head_unavailable');
  try { runGit(repo, ['cat-file', '-e', `${remoteCommit}^{commit}`], { timeout: 2000 }); }
  catch (_) { runGit(repo, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', remoteCommit], { timeout: 5000 }); }
  const state = compareCommits(repo, localCommit, remoteCommit, runGit, { throwOnError: true });
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
  return successfulResult({
    source_mode: 'clone', identity, version, localCommit, remoteCommit, state,
    has_update: hasUpdate, remote_version: remoteVersion, generation });
}

// Runs only in the bounded refresh subprocess, never on the render path.
function refresh(target, options = {}) {
  const file = cachePath(target, options.cacheDir);
  ensureCacheDirectory(file);
  const generation = readGeneration(file);
  const previous = readCache(file);
  const rawGit = options.git || git;
  const runGit = (cwd, args, gitOptions) => callGit(rawGit, cwd, args, gitOptions);
  let next;
  let source = null;
  let identity = null;
  let localCommit = null;
  try {
    source = resolveInstalledSource(target, options);
    if (source.mode === 'remote') {
      identity = sourceIdentity(source);
      next = remoteRefresh(source, generation, runGit);
    } else {
      localCommit = String(runGit(source.repo, ['rev-parse', '--verify', 'HEAD'], { timeout: 2000 })).trim();
      if (!SHA_PATTERN.test(localCommit)) throw new Error('local_commit_unavailable');
      identity = sourceIdentity(source, localCommit);
      next = cloneRefresh(source, generation, runGit, { localCommit, identity });
    }
  } catch (error) {
    const code = diagnosticCode(error);
    const sourceMode = source ? source.mode : 'invalid';
    const version = source && source.version ? source.version : '';
    if (error && error.transient) {
      const retryAfter = Date.now() + TRANSIENT_RETRY_MS;
      if (previous && identity && previous.identity === identity
        && (previous.generation || null) === (generation || null)
        && Number.isFinite(previous.last_success_ts)) {
        next = { ...previous, error: code, retry_after: retryAfter, generation };
      } else {
        next = unknownResult({ identity, sourceMode, version, error: code, generation, retryAfter });
      }
    } else {
      next = unknownResult({ identity, sourceMode, version, error: code, generation });
    }
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
  const file = cachePath(context, options.cacheDir);
  const unknown = { state: 'unknown', version: '', has_update: false, remote_version: '' };
  try { ensureCacheDirectory(file); } catch (_) { return unknown; }
  const cache = readCache(file);
  const due = !cache || (cache.retry_after != null
    ? Date.now() >= cache.retry_after
    : Date.now() - cache.ts >= TTL_MS);
  if (due) {
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
      target = resolveConsumerContext(process.argv[4]);
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
  renderContext,
  resolveRepoPath,
  resolveConsumerContext,
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
    TRANSIENT_RETRY_MS,
    SHA_PATTERN,
    STABLE_TAG_PATTERN,
    readCache,
    spawnRequest,
    sourceIdentity,
    targetFromRequest,
    validateRemoteSource,
  },
};
