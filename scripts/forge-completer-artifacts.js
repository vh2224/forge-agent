#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const vcsApi = require('./forge-vcs.js');

function lines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function gitBase(cwd, explicitBase) {
  const candidates = explicitBase ? [explicitBase] : ['origin/HEAD', 'master', 'main'];
  for (const candidate of candidates) {
    try {
      const base = execFileSync('git', ['merge-base', 'HEAD', candidate], { cwd, encoding: 'utf8' }).trim();
      if (base) return { ref: candidate, oid: base };
    } catch { /* a candidate is usable only when Git resolves it */ }
  }
  return null;
}

function gitActualAm(cwd, opts = {}) {
  const base = gitBase(cwd, opts.baseRef);
  if (!base) return { vcs: 'git', ok: false, paths: [], error: 'file-audit-unavailable:git:no-base' };
  try {
    const changed = lines(execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', `${base.oid}...HEAD`], { cwd, encoding: 'utf8' }));
    const untracked = lines(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' }));
    return { vcs: 'git', ok: true, paths: Array.from(new Set([...changed, ...untracked])).sort(), scope: 'branch' };
  } catch (error) {
    return { vcs: 'git', ok: false, paths: [], error: `file-audit-unavailable:git:${error.message}` };
  }
}

function actualAddedModified(cwd, opts = {}) {
  const vcs = opts.vcs || vcsApi.detectVcs(cwd);
  if (vcs === 'git') return gitActualAm(cwd, opts);
  if (vcs === 'svn') {
    const status = vcsApi.workingStatus(cwd, { vcs: 'svn' });
    if (!status.ok) return { vcs, ok: false, paths: [], error: `file-audit-unavailable:svn:${status.error}` };
    const paths = status.entries
      .filter((entry) => ['added', 'modified', 'untracked'].includes(entry.kind))
      .map((entry) => entry.path.split(path.sep).join('/'));
    return { vcs, ok: true, paths: Array.from(new Set(paths)).sort(), scope: 'working-copy' };
  }
  return { vcs, ok: false, paths: [], error: `file-audit-unavailable:${vcs || 'unknown'}` };
}

function main(argv) {
  const cwdIndex = argv.indexOf('--cwd');
  if (!argv.includes('--actual-am') || cwdIndex < 0 || !argv[cwdIndex + 1]) {
    process.stderr.write('forge-completer-artifacts: --actual-am --cwd <path> required\n');
    return 1;
  }
  const result = actualAddedModified(argv[cwdIndex + 1]);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    return 2;
  }
  for (const item of result.paths) process.stdout.write(`${item}\n`);
  return 0;
}

module.exports = { actualAddedModified, gitActualAm, gitBase };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
