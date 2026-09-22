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

function cachePath(repo, directory = os.tmpdir()) {
  let identity = path.resolve(repo);
  try { identity = fs.realpathSync.native(identity); } catch {}
  if (process.platform === 'win32') identity = identity.toLowerCase();
  return path.join(directory, `forge-update-${crypto.createHash('sha256').update(identity).digest('hex')}.json`);
}

function readCache(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : null; }
  catch { return null; }
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
  const previous = readCache(file) || {};
  let next = { ...previous, ts: Date.now(), state: 'unknown' };
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
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(next), 'utf8'); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
  return next;
}

function cachedUpdate(repo, options = {}) {
  const file = cachePath(repo, options.cacheDir);
  const cache = readCache(file);
  if (!cache || Date.now() - (cache.ts || 0) >= TTL_MS) {
    const marker = `${file}.refresh`;
    try {
      try { if (Date.now() - fs.statSync(marker).mtimeMs > REFRESH_TIMEOUT_MS) fs.unlinkSync(marker); } catch {}
      const fd = fs.openSync(marker, 'wx'); fs.closeSync(fd);
      const launch = options.spawn || spawn;
      try {
        const child = launch(process.execPath, [__filename, '--refresh', path.resolve(repo), path.dirname(file)],
          { stdio: 'ignore', windowsHide: true, detached: true });
        child.on('error', () => { try { fs.unlinkSync(marker); } catch {} });
        child.unref();
      } catch { try { fs.unlinkSync(marker); } catch {} }
    } catch { /* another renderer has already scheduled the refresh */ }
  }
  return cache || { state: 'unknown', version: '', has_update: false, remote_version: '' };
}

if (require.main === module && process.argv[2] === '--refresh') {
  const repo = process.argv[3];
  const cacheDir = process.argv[4];
  try { refresh(repo, { cacheDir }); }
  finally { try { fs.unlinkSync(`${cachePath(repo, cacheDir)}.refresh`); } catch {} }
}

module.exports = { cachePath, compareCommits, refresh, cachedUpdate, TTL_MS };
