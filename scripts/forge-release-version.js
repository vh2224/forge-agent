#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { TextDecoder } = require('util');
const { evaluateImpact, parseImpact, IMPACT_VERSION } = require('./forge-release-impact.js');

const COMMIT_LIMITS = Object.freeze({ max_commits: 10000, max_bytes: 16777216 });
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function failure(code, detail, cause) {
  return Object.assign(new Error(`${code}: ${detail}`, cause ? { cause } : undefined), { code });
}

function parseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || '').trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function classifyCommit(message) {
  const subject = String(message).trim();
  if (/^[a-z]+(?:\(.+\))?!:|BREAKING[ -]CHANGE/i.test(subject)) return 'major';
  if (/^feat(?:\(.+\))?:/.test(subject)) return 'minor';
  if (/^fix(?:\(.+\))?:/.test(subject)) return 'patch';
  return 'none';
}

function bumpFor(commits) {
  const subjects = (Array.isArray(commits) ? commits : []).map(classifyCommit);
  return ['major', 'minor', 'patch'].find(bump => subjects.includes(bump)) || 'none';
}

function nextTag(latestTag, bump) {
  const version = parseTag(latestTag) || { major: 0, minor: 0, patch: 0 };
  if (bump === 'major') return `v${version.major + 1}.0.0`;
  if (bump === 'minor') return `v${version.major}.${version.minor + 1}.0`;
  if (bump === 'patch') return `v${version.major}.${version.minor}.${version.patch + 1}`;
  return latestTag || null;
}

function resolveFromFacts({ headTags = [], latestTag = null, commits = [] } = {}, testOptions) {
  const invalidHeadTag = headTags.find(tag => !parseTag(tag));
  if (invalidHeadTag) {
    const error = new Error(`invalid release tag at HEAD: ${invalidHeadTag}`);
    error.code = 'invalid-release-tag';
    throw error;
  }
  const validHeadTags = headTags.filter(parseTag).sort((a, b) => {
    const av = parseTag(a); const bv = parseTag(b);
    return av.major - bv.major || av.minor - bv.minor || av.patch - bv.patch;
  });
  const normalized = (Array.isArray(commits) ? commits : []).map(commit => typeof commit === 'string'
    ? { sha: null, message: commit } : commit && typeof commit.message === 'string'
      ? commit : { sha: null, message: null });
  let resolution;
  if (validHeadTags.length) {
    const newTag = validHeadTags[validHeadTags.length - 1];
    resolution = { skip: false, new_tag: newTag, range: `${newTag}^..HEAD`, bump: 'tagged', latest_tag: latestTag };
  } else {
    const bump = bumpFor((Array.isArray(commits) ? commits : []).map(commit =>
      commit && typeof commit.message === 'string' ? commit.message : commit));
    resolution = { skip: bump === 'none', new_tag: nextTag(latestTag, bump),
      range: latestTag ? `${latestTag}..HEAD` : 'HEAD', bump, latest_tag: latestTag };
  }
  try {
    resolution.impact = evaluateImpact({ commits: normalized, label_bump: resolution.bump,
      head_tagged: validHeadTags.length > 0, classify: classifyCommit }, testOptions && testOptions.impactOptions);
  } catch (error) {
    const reason = error && typeof error.code === 'string' && /^impact-[a-z]+(?:-[a-z]+)*$/.test(error.code)
      ? error.code : 'impact-evaluation-failed';
    resolution.impact = { version: IMPACT_VERSION, status: 'invalid', required: 'none', label_bump: 'none',
      declared_commits: 0, undeclared_commits: 0, invalid_count: 0, conflict_count: 0,
      diagnostics: [], diagnostics_omitted: 0, reason };
  }
  return resolution;
}

function readCommits(cwd, range, options = {}) {
  const match = typeof range === 'string' && /^(?:v\d+\.\d+\.\d+\^?\.\.HEAD|HEAD)$/.exec(range);
  if (!match || match[0] !== range) throw failure('version-range-invalid', 'intervalo recusado');
  const limits = { ...COMMIT_LIMITS, ...options.limits };
  const run = options.spawnSync || spawnSync;
  const listed = run('git', ['-C', cwd, 'rev-list', `--max-count=${limits.max_commits + 1}`, range, '--'],
    { shell: false, encoding: 'utf8', maxBuffer: (limits.max_commits + 1) * 66 });
  if (!listed || listed.error || listed.status !== 0) throw failure('version-history-unreadable', 'rev-list falhou', listed && listed.error);
  const shas = String(listed.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (shas.length > limits.max_commits) throw failure('version-history-too-large', 'limite de commits excedido');
  if (shas.some(sha => !SHA.test(sha))) throw failure('version-commit-malformed', 'SHA inválido');
  if (!shas.length) return [];
  // Overhead de cada registro: SHA64, tipo, tamanho decimal, dois LFs.
  const result = run('git', ['-C', cwd, 'cat-file', '--batch'], { shell: false,
    input: `${shas.join('\n')}\n`, maxBuffer: limits.max_bytes + limits.max_commits * 100 });
  if (!result || result.error || result.status !== 0) throw failure('version-history-unreadable', 'cat-file falhou', result && result.error);
  const bytes = result.stdout;
  if (!Buffer.isBuffer(bytes)) throw failure('version-commit-malformed', 'saída binária ausente');
  let offset = 0; let total = 0;
  const records = [];
  for (const sha of shas) {
    const end = bytes.indexOf(10, offset);
    const header = end < 0 ? null : /^([0-9a-f]{40}|[0-9a-f]{64}) commit (0|[1-9][0-9]*)$/.exec(bytes.subarray(offset, end).toString('latin1'));
    if (!header || header[0].length !== end - offset || header[1] !== sha) throw failure('version-commit-malformed', 'cabeçalho divergente');
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size)) throw failure('version-commit-malformed', 'tamanho inválido');
    total += size;
    if (total > limits.max_bytes) throw failure('version-history-too-large', 'limite de bytes excedido');
    offset = end + 1;
    if (offset + size >= bytes.length || bytes[offset + size] !== 10) throw failure('version-commit-malformed', 'tamanho ou LF divergente');
    const object = bytes.subarray(offset, offset + size);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(object); }
    catch (error) { throw failure('version-commit-malformed', 'UTF-8 inválido', error); }
    const separator = text.indexOf('\n\n');
    if (object.includes(0) || separator < 0) throw failure('version-commit-malformed', 'objeto sem mensagem ou com NUL');
    // Mensagem íntegra: a validação de impacto precisa ver controles/espaços finais.
    records.push({ sha, message: text.slice(separator + 2) });
    offset += size + 1;
  }
  if (offset !== bytes.length) throw failure('version-commit-malformed', 'EOF divergente');
  return records;
}

function git(cwd, args, allowEmpty = false) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false });
  if (!result || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result && result.stderr ? result.stderr.trim() : 'unknown error'}`);
  const text = String(result.stdout || '').trim();
  return allowEmpty && !text ? [] : text.split(/\r?\n/).filter(Boolean);
}

function resolveVersion(cwd = process.cwd()) {
  const inside = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', shell: false });
  if (!inside || inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    const error = new Error('version provenance unavailable: source is not a Git worktree');
    error.code = 'version-not-git';
    throw error;
  }
  const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', shell: false });
  const sameDirectory = (left, right) => {
    try {
      const a = fs.statSync(path.resolve(String(left || '').trim()));
      const b = fs.statSync(path.resolve(String(right || '').trim()));
      return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
    } catch (_) { return false; }
  };
  if (!top || top.status !== 0 || !sameDirectory(top.stdout, cwd)) {
    const error = new Error('version provenance unavailable: Git belongs to an ancestor, not this Forge root');
    error.code = 'version-not-git';
    throw error;
  }
  const shallow = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8', shell: false });
  if (!shallow || shallow.status !== 0 || String(shallow.stdout || '').trim() === 'true') {
    const error = new Error('version history incomplete: fetch full history and tags before installing or packaging');
    error.code = 'version-history-incomplete';
    throw error;
  }
  const headTags = git(cwd, ['tag', '--points-at', 'HEAD', '-l', 'v*'], true);
  const allTags = git(cwd, ['tag', '-l', 'v*', '--sort=-v:refname'], true).filter(parseTag);
  const latestTag = allTags[0] || null;
  const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
  const commits = readCommits(cwd, range);
  return resolveFromFacts({ headTags, latestTag, commits });
}

function checkDeclaredVersion(resolution, declared) {
  if (declared === undefined) declared = require('./forge-version.js').VERSION;
  const expected = String(resolution.new_tag || '').replace(/^v/, '');
  if (!expected) throw new Error('release version cannot be checked without an expected tag');
  if (declared !== expected) {
    const error = new Error(`product VERSION ${declared} does not match ${resolution.skip ? 'latest' : 'next'} release ${expected}; bump scripts/forge-version.js and regenerate its golden/literal consumers`);
    error.code = 'declared-version-mismatch';
    throw error;
  }
  const impact = resolution.impact;
  if (impact && ['conflict', 'invalid'].includes(impact.status)) {
    const code = impact.status === 'conflict' ? 'impact-label-conflict' : 'impact-invalid';
    const diagnostics = impact.diagnostics.slice(0, 8).map(item =>
      `${item.surface || '?'}/${item.kind || '?'} ${item.sha ? item.sha.slice(0, 7) : '?'} rótulo=${item.label || impact.label_bump} ${item.reason || item.code}`);
    const omitted = Math.max(0, impact.diagnostics.length - 8) + impact.diagnostics_omitted;
    if (omitted) diagnostics.push(`+${omitted} omitidos`);
    throw failure(code, `${diagnostics.join('; ') || impact.reason} (conflitos: ${impact.conflict_count})`);
  }
  return { ok: true, declared, expected, skip: resolution.skip, bump: resolution.bump };
}

function appendGithubOutput(file, resolution) {
  const rows = [`new_tag=${resolution.new_tag || ''}`, `skip=${resolution.skip ? 'true' : 'false'}`,
    `range=${resolution.range}`, `bump=${resolution.bump}`];
  fs.appendFileSync(file, `${rows.join('\n')}\n`, 'utf8');
}

function renderChangelog(records) {
  const sections = { major: ['Breaking Changes', []], minor: ['Features', []],
    patch: ['Bug Fixes', []], none: ['Other Changes', []] };
  for (const { sha, message } of records) {
    if (typeof sha !== 'string' || ![40, 64].includes(sha.length) || !SHA.test(sha)) throw failure('changelog-record-invalid', 'SHA inválido');
    const subject = message.trim().split(/\r?\n\r?\n/)[0].replace(/\s+/g, ' ').trim();
    const declarations = parseImpact(message).declarations;
    const annotation = declarations.length ? ` [impacto: ${declarations.map(item => `${item.surface}/${item.kind}`).join(', ')}]` : '';
    sections[classifyCommit(message)][1].push(`- ${subject} (${sha.slice(0, 7)})${annotation}`);
  }
  return Object.values(sections).filter(([, rows]) => rows.length)
    .map(([title, rows]) => `### ${title}\n\n${rows.join('\n')}\n`).join('\n');
}

function collectNotesCommits(cwd, resolution, options = {}) {
  try { return readCommits(cwd, resolution.range, options); }
  catch (cause) {
    const match = typeof resolution.range === 'string' && /^(v\d+\.\d+\.\d+)\^\.\.HEAD$/.exec(resolution.range);
    if (match && match[0] === resolution.range) {
      const result = (options.spawnSync || spawnSync)('git', ['-C', cwd, 'rev-list', '--parents', '-n', '1', `${match[1]}^{commit}`],
        { shell: false, encoding: 'utf8', maxBuffer: 256 });
      if (result && !result.error && result.status === 0 && SHA.test(String(result.stdout || '').trim())) {
        try { return readCommits(cwd, 'HEAD', options); }
        catch (error) { throw failure('changelog-range-unavailable', 'fallback HEAD falhou', error); }
      }
    }
    throw failure('changelog-range-unavailable', 'intervalo indisponível', cause);
  }
}

function main(argv = process.argv.slice(2)) {
  const resolution = resolveVersion(process.cwd());
  if (argv.includes('--check')) checkDeclaredVersion(resolution);
  const outputAt = argv.indexOf('--github-output');
  if (outputAt !== -1) {
    if (!argv[outputAt + 1]) throw new Error('--github-output requires a file');
    appendGithubOutput(argv[outputAt + 1], resolution);
  }
  const notesAt = argv.indexOf('--notes');
  if (notesAt !== -1) {
    if (!argv[notesAt + 1] || argv[notesAt + 1].startsWith('--')) throw new Error('--notes requires a file');
    fs.writeFileSync(argv[notesAt + 1], renderChangelog(collectNotesCommits(process.cwd(), resolution)), { encoding: 'utf8', flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(resolution)}\n`);
}

module.exports = { parseTag, bumpFor, nextTag, resolveFromFacts, resolveVersion, checkDeclaredVersion, appendGithubOutput,
  classifyCommit, readCommits, collectNotesCommits, renderChangelog, COMMIT_LIMITS };

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`forge-release-version: ${error.message}\n`); process.exit(1); }
}
