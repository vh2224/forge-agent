'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { git } = require('./forge-git-process');
const { parseStableTags } = require('./forge-update-remote');
const TTL_MS = 600000;
const REFRESH_TIMEOUT_MS = 60000;

function cachePath(repo, directory = path.join(os.tmpdir(), `forge-update-cache-${crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 24)}`)) {
  let identity = path.resolve(repo);
  try { identity = fs.realpathSync.native(identity); } catch {}
  if (process.platform === 'win32') identity = identity.toLowerCase();
  return path.join(directory, `forge-update-${crypto.createHash('sha256').update(identity).digest('hex')}.json`);
}

function ensureCacheDirectory(file) {
  const directory = path.dirname(file);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Unsafe update cache directory');
  }
}

function readPrivateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Unsafe update cache file');
  return fs.readFileSync(file, 'utf8');
}

function publish(file, contents) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, contents, 'utf8'); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (created) { try { fs.unlinkSync(temporary); } catch {} } }
}

function readCache(file) {
  try {
    const value = JSON.parse(readPrivateFile(file));
    const safeText = text => typeof text === 'string' && text.length <= 256 && !/[\x00-\x1f\x7f-\x9f]/.test(text);
    const valid = value && typeof value === 'object' && !Array.isArray(value)
      && Number.isFinite(value.ts) && value.ts >= 0 && typeof value.has_update === 'boolean'
      && ['unknown', 'equal', 'behind', 'ahead', 'diverged'].includes(value.state)
      && safeText(value.version) && safeText(value.remote_version)
      && (value.generation == null || /^[a-f0-9-]{36}$/.test(value.generation));
    return valid && (value.generation || null) === readGeneration(file) ? value : null;
  }
  catch { return null; }
}

function readGeneration(file) {
  try {
    const generation = readPrivateFile(`${file}.generation`);
    if (!/^[a-f0-9-]{36}$/.test(generation)) throw new Error('Invalid update cache generation');
    return generation;
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function resolveRepoPath(prefs, cwd = process.cwd()) {
  const repo = typeof prefs.repo_path === 'string' ? prefs.repo_path.trim() : '';
  return repo ? path.resolve(cwd, repo) : null;
}

function invalidateCache(repo, options = {}) {
  if (typeof repo !== 'string' || !repo.trim()) throw new Error('A repository path is required');
  const file = cachePath(repo, options.cacheDir);
  ensureCacheDirectory(file);
  // Readers reject an older worker's publication, including a rename that
  // races with this invalidation after the worker's last possible check.
  publish(`${file}.generation`, crypto.randomUUID());
  try { fs.unlinkSync(file); return { invalidated: true, file }; }
  catch (error) {
    if (error.code === 'ENOENT') return { invalidated: false, reason: 'cache-missing', file };
    throw error;
  }
}

function compareCommits(repo, local, remote) {
  if (!/^[a-f0-9]{40,64}$/.test(local) || !/^[a-f0-9]{40,64}$/.test(remote)) return 'unknown';
  if (local === remote) return 'equal';
  const ancestor = (left, right) => {
    try { git(repo, ['merge-base', '--is-ancestor', left, right], { timeout: 2000 }); return true; }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  try {
    if (ancestor(local, remote)) return 'behind';
    if (ancestor(remote, local)) return 'ahead';
    return 'diverged';
  } catch { return 'unknown'; }
}

// Runs only in the bounded refresh subprocess, never on the render path.
function refresh(repo, options = {}) {
  const file = cachePath(repo, options.cacheDir);
  ensureCacheDirectory(file);
  const generation = readGeneration(file);
  const previous = readCache(file) || {};
  let next = { version: '', has_update: false, remote_version: '', ...previous, ts: Date.now(), state: 'unknown' };
  try {
    const localCommit = git(repo, ['rev-parse', '--verify', 'HEAD'], { timeout: 2000 }).trim();
    let version = localCommit.slice(0, 8);
    try { version = git(repo, ['describe', '--tags', '--always'], { timeout: 2000 }).trim().replace(/^(v[\d.]+)-(\d+)-g[0-9a-f]+$/, '$1.$2'); } catch {}
    next = { ...next, version, localCommit };
    // A previous verdict belongs to its checkout, even when origin is offline.
    if (previous.localCommit !== localCommit) {
      next.has_update = false;
      next.remote_version = '';
    }
    const remoteCommit = git(repo, ['ls-remote', 'origin', 'HEAD'], { timeout: 5000 }).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40,64}$/.test(remoteCommit)) throw new Error('remote HEAD unavailable');
    // Fetch the object only when needed for ancestry. No branch/ref/FETCH_HEAD
    // changes: this is an object-database refresh, not a checkout or update.
    try { git(repo, ['cat-file', '-e', `${remoteCommit}^{commit}`], { timeout: 2000 }); }
    catch { git(repo, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', remoteCommit], { timeout: 5000 }); }
    const state = compareCommits(repo, localCommit, remoteCommit);
    if (state === 'unknown') throw new Error('ancestry unavailable');
    const hasUpdate = state === 'behind' || state === 'diverged';
    let remoteVersion = '';
    if (hasUpdate) {
      try {
        const tags = parseStableTags(git(repo, ['ls-remote', '--tags', 'origin'], { timeout: 5000 }));
        const tag = tags.find(entry => entry.sha === remoteCommit);
        remoteVersion = tag ? `v${tag.version}` : remoteCommit.slice(0, 8);
      } catch { remoteVersion = remoteCommit.slice(0, 8); }
    }
    next = { ts: Date.now(), last_success_ts: Date.now(), version, localCommit, remoteCommit,
      state, has_update: hasUpdate, remote_version: remoteVersion };
  } catch {
    // Preserve the last known indication on network errors; unknown is explicit.
    next.error = 'update-check-unavailable';
  }
  next.generation = generation;
  publish(file, JSON.stringify(next));
  return next;
}

function cachedUpdate(repo, options = {}) {
  const file = cachePath(repo, options.cacheDir);
  const unknown = { state: 'unknown', version: '', has_update: false, remote_version: '' };
  try { ensureCacheDirectory(file); } catch { return unknown; }
  const cache = readCache(file);
  if (!cache || Date.now() - (cache.ts || 0) >= TTL_MS) {
    const marker = `${file}.refresh`;
    try {
      try { if (Date.now() - fs.statSync(marker).mtimeMs > REFRESH_TIMEOUT_MS) fs.unlinkSync(marker); } catch {}
      const fd = fs.openSync(marker, 'wx', 0o600); fs.closeSync(fd);
      const launch = options.spawn || spawn;
      try {
        const child = launch(process.execPath, [__filename, '--refresh', path.resolve(repo), path.dirname(file)],
          { stdio: 'ignore', windowsHide: true, detached: true });
        child.on('error', () => { try { fs.unlinkSync(marker); } catch {} });
        child.unref();
      } catch { try { fs.unlinkSync(marker); } catch {} }
    } catch { /* another renderer has already scheduled the refresh */ }
  }
  return cache || unknown;
}

if (require.main === module && process.argv[2] === '--refresh') {
  const repo = process.argv[3];
  const cacheDir = process.argv[4];
  try { refresh(repo, { cacheDir }); }
  finally {
    try {
      const file = cachePath(repo, cacheDir);
      ensureCacheDirectory(file);
      fs.unlinkSync(`${file}.refresh`);
    } catch {}
  }
}

if (require.main === module && process.argv[2] === '--invalidate') {
  try {
    let repo = process.argv[3], cacheDir = process.argv[4];
    if (repo === '--cwd') {
      if (!process.argv[4]) throw new Error('--cwd requires a consumer directory');
      const cwd = path.resolve(process.argv[4]);
      const { prefs } = require('./forge-prefs').readPrefsCached(cwd);
      repo = resolveRepoPath(prefs, cwd);
      cacheDir = process.argv[5];
      if (!repo) console.log(JSON.stringify({ invalidated: false, reason: 'repo-path-unconfigured' }));
    }
    if (repo) console.log(JSON.stringify(invalidateCache(repo, { cacheDir })));
    else if (process.argv[3] !== '--cwd') throw new Error('--invalidate requires a repository path or --cwd <consumer>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { cachePath, resolveRepoPath, invalidateCache, compareCommits, refresh, cachedUpdate, TTL_MS };
