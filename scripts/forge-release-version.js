#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

function parseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || '').trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function bumpFor(commits) {
  const subjects = Array.isArray(commits) ? commits : [];
  if (subjects.some(subject => /^[a-z]+(?:\(.+\))?!:|BREAKING[ -]CHANGE/i.test(subject))) return 'major';
  if (subjects.some(subject => /^feat(?:\(.+\))?:/.test(subject))) return 'minor';
  if (subjects.some(subject => /^fix(?:\(.+\))?:/.test(subject))) return 'patch';
  return 'none';
}

function nextTag(latestTag, bump) {
  const version = parseTag(latestTag) || { major: 0, minor: 0, patch: 0 };
  if (bump === 'major') return `v${version.major + 1}.0.0`;
  if (bump === 'minor') return `v${version.major}.${version.minor + 1}.0`;
  if (bump === 'patch') return `v${version.major}.${version.minor}.${version.patch + 1}`;
  return latestTag || null;
}

function resolveFromFacts({ headTags = [], latestTag = null, commits = [] } = {}) {
  const validHeadTags = headTags.filter(parseTag).sort((a, b) => {
    const av = parseTag(a); const bv = parseTag(b);
    return av.major - bv.major || av.minor - bv.minor || av.patch - bv.patch;
  });
  if (validHeadTags.length) {
    const newTag = validHeadTags[validHeadTags.length - 1];
    return { skip: false, new_tag: newTag, range: `${newTag}^..HEAD`, bump: 'tagged', latest_tag: latestTag };
  }
  const bump = bumpFor(commits);
  if (bump === 'none') return { skip: true, new_tag: latestTag, range: latestTag ? `${latestTag}..HEAD` : 'HEAD', bump, latest_tag: latestTag };
  return { skip: false, new_tag: nextTag(latestTag, bump), range: latestTag ? `${latestTag}..HEAD` : 'HEAD', bump, latest_tag: latestTag };
}

function git(cwd, args, allowEmpty = false) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false });
  if (!result || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result && result.stderr ? result.stderr.trim() : 'unknown error'}`);
  const text = String(result.stdout || '').trim();
  return allowEmpty && !text ? [] : text.split(/\r?\n/).filter(Boolean);
}

function resolveVersion(cwd = process.cwd()) {
  const headTags = git(cwd, ['tag', '--points-at', 'HEAD', '-l', 'v*'], true);
  const allTags = git(cwd, ['tag', '-l', 'v*', '--sort=-v:refname'], true);
  const latestTag = allTags[0] || null;
  const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
  const log = spawnSync('git', ['-C', cwd, 'log', range, '--pretty=format:%B%x1e'], { encoding: 'utf8', shell: false });
  if (!log || log.status !== 0) throw new Error(`git log ${range} failed: ${log && log.stderr ? log.stderr.trim() : 'unknown error'}`);
  const commits = String(log.stdout || '').split('\x1e').map(value => value.trim()).filter(Boolean);
  return resolveFromFacts({ headTags, latestTag, commits });
}

function checkDeclaredVersion(resolution, declared) {
  if (declared === undefined) declared = require('./forge-version.js').VERSION;
  const expected = String(resolution.new_tag || '').replace(/^v/, '');
  if (!expected) throw new Error('release version cannot be checked without an expected tag');
  if (declared !== expected) {
    throw new Error(`product VERSION ${declared} does not match ${resolution.skip ? 'latest' : 'next'} release ${expected}; bump scripts/forge-version.js and regenerate its golden/literal consumers`);
  }
  return { ok: true, declared, expected, skip: resolution.skip, bump: resolution.bump };
}

function appendGithubOutput(file, resolution) {
  const rows = [`new_tag=${resolution.new_tag || ''}`, `skip=${resolution.skip ? 'true' : 'false'}`,
    `range=${resolution.range}`, `bump=${resolution.bump}`];
  fs.appendFileSync(file, `${rows.join('\n')}\n`, 'utf8');
}

function main(argv = process.argv.slice(2)) {
  const resolution = resolveVersion(process.cwd());
  if (argv.includes('--check')) checkDeclaredVersion(resolution);
  const outputAt = argv.indexOf('--github-output');
  if (outputAt !== -1) {
    if (!argv[outputAt + 1]) throw new Error('--github-output requires a file');
    appendGithubOutput(argv[outputAt + 1], resolution);
  }
  process.stdout.write(`${JSON.stringify(resolution)}\n`);
}

module.exports = { parseTag, bumpFor, nextTag, resolveFromFacts, resolveVersion, checkDeclaredVersion, appendGithubOutput };

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`forge-release-version: ${error.message}\n`); process.exit(1); }
}
