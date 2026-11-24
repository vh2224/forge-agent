'use strict';
// Only capture writes an object. Historical/current readers never recover a
// missing captured blob from today's policy or mutate the object database.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { git } = require('./forge-git-process');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const fail = () => { throw Object.assign(new Error('delivery-source-policy-unproven'), { code: 'delivery-source-policy-unproven' }); };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ignoredInventory(root) {
  try {
    const paths = git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', '.',
      ':(glob,exclude)**/node_modules/**', ':(glob,exclude)**/.gsd/**',
      ':(glob,exclude)**/.git/**', ':(glob,exclude)**/.svn/**'], {
      maxBuffer: 4 * 1024 * 1024, timeout: 10000,
      env: { GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    }).split('\0').filter(Boolean);
    if (paths.length > 65536) fail();
    const installation = require('./forge-surgical-reset').isInstallArtifactPath;
    const sources = paths.filter(value => !installation(value) && !/(?:^|\/)(?:\.gsd|\.git|\.svn)(?:\/|$)/.test(value));
    if (sources.some(value => value.length > 1024 || /[\\\x00-\x1f:]/.test(value)
        || value.split('/').some(part => !part || part === '.' || part === '..'))) fail();
    return [...new Set(sources)].sort();
  } catch { fail(); }
}
function capturePolicy(root, snapshot) {
  const row = snapshot.pre_dirty.find(entry => entry.path === '.gitignore');
  if (!row || row.hash === null) return;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.hash || '')) fail();
  const file = path.join(root, '.gitignore');
  try {
    const initial = fs.lstatSync(file);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) fail();
    const first = readBoundedStableFile(file, 1024 * 1024, { expectedReal: file });
    if (first.error || first.stat.nlink !== 1) fail();
    const stored = git(root, ['hash-object', '-w', '--path=.gitignore', '--stdin'], {
      input: first.buffer, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4096,
    }).trim();
    const last = readBoundedStableFile(file, 1024 * 1024, { expectedReal: file });
    const final = fs.lstatSync(file);
    if (stored !== row.hash || last.error || !first.buffer.equals(last.buffer)
        || !final.isFile() || final.isSymbolicLink() || final.nlink !== 1
        || first.stat.dev !== last.stat.dev || first.stat.ino !== last.stat.ino
        || first.stat.mtimeMs !== last.stat.mtimeMs || first.stat.ctimeMs !== last.stat.ctimeMs) fail();
  } catch { fail(); }
}
function capture(root, snapshot) {
  if (snapshot.vcs !== 'git') return;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.start_sha || '') || !Array.isArray(snapshot.pre_dirty)) fail();
  const ignored = ignoredInventory(root);
  capturePolicy(root, snapshot);
  // No history reader inventories today's ignores. The captured inventory is
  // bound to the same revision and exact dirty overlay as its source envelope.
  const final = require('./forge-surgical-reset').captureAttemptSnapshot(root);
  if (final.start_sha !== snapshot.start_sha || digest(final.pre_dirty) !== digest(snapshot.pre_dirty)
      || digest(ignoredInventory(root)) !== digest(ignored)) fail();
  const body = { schema_version: 1, revision: snapshot.start_sha,
    workspace_sha256: digest(snapshot.pre_dirty), ignored };
  return { ...body, sha256: digest(body) };
}
function irrelevantRule(rule, pattern) {
  // These namespaces cannot be delivery sources at any depth (code-roots).
  if (['.gsd/', '.git/', '.svn/'].includes(rule)) return true;
  if (rule.includes('\\')) return false;
  const body = rule.replace(/^!/, ''), anchored = body.startsWith('/');
  const relative = body.replace(/^\//, '').replace(/\/$/, '');
  // A basename rule also applies below the source prefix; it is not a root
  // path just because the current checkout has no matching nested directory.
  if (!anchored && !relative.includes('/')) return false;
  const rulePrefix = relative.split(/[*?\[]/, 1)[0];
  const fixedRule = /[*?\[]/.test(relative) ? rulePrefix.replace(/[^/]*$/, '') : rulePrefix;
  const fixedSource = pattern.slice(0, pattern.search(/[*?]/)).replace(/[^/]*$/, '');
  const a = fixedRule.replace(/\/$/, ''), b = fixedSource.replace(/\/$/, '');
  if (!a || !b || [a,b].some(value => value.split('/').some(part => !part || part === '.' || part === '..'))) return false;
  return a !== b && !a.startsWith(b + '/') && !b.startsWith(a + '/');
}
module.exports = { capture, irrelevantRule };
