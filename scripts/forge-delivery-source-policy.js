'use strict';
// Only capture writes an object. Historical/current readers never recover a
// missing captured blob from today's policy or mutate the object database.
const fs = require('fs');
const path = require('path');
const { git } = require('./forge-git-process');
const { readBoundedStableFile } = require('./forge-autonomy-sources');
const fail = () => { throw Object.assign(new Error('delivery-source-policy-unproven'), { code: 'delivery-source-policy-unproven' }); };
function capture(root, snapshot) {
  if (snapshot.vcs !== 'git') return;
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
