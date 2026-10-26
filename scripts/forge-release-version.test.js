#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const api = require('./forge-release-version.js');
const product = require('./forge-version.js');

function git(cwd, args) {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false });
  assert.strictEqual(out.status, 0, out.stderr);
}

assert.strictEqual(api.bumpFor(['docs: note', 'fix(core): bug']), 'patch');
assert.strictEqual(api.bumpFor(['fix: bug', 'feat(core): capability']), 'minor');
assert.strictEqual(api.bumpFor(['feat!: break']), 'major');
assert.strictEqual(api.bumpFor(['feat: api\n\nBREAKING CHANGE: removed field']), 'major');
assert.strictEqual(api.bumpFor(['docs: note']), 'none');
assert.strictEqual(api.nextTag('v4.19.6', 'minor'), 'v4.20.0');
assert.strictEqual(api.nextTag('v4.20.0', 'patch'), 'v4.20.1');
assert.strictEqual(product.archiveVersion(path.join('tmp', 'forge-agent-4.20.7')), '4.20.7');
assert.strictEqual(product.archiveVersion(path.join('tmp', 'forge-agent-main')), null);
assert.throws(() => api.resolveFromFacts({ headTags: ['vbanana'], latestTag: 'v4.20.0', commits: [] }),
  error => error.code === 'invalid-release-tag');

const next = api.resolveFromFacts({ latestTag: 'v4.20.0', commits: ['fix(release): enforce version'] });
assert.deepStrictEqual(next, { skip: false, new_tag: 'v4.20.1', range: 'v4.20.0..HEAD', bump: 'patch', latest_tag: 'v4.20.0', impact: { version: 1, status: 'partial', required: 'none', label_bump: 'patch', declared_commits: 0, undeclared_commits: 1, invalid_count: 0, conflict_count: 0, diagnostics: [], diagnostics_omitted: 0, reason: null } });
assert.deepStrictEqual(api.checkDeclaredVersion(next, '4.20.1'),
  { ok: true, declared: '4.20.1', expected: '4.20.1', skip: false, bump: 'patch' });
assert.throws(() => api.checkDeclaredVersion(next, '4.20.0'), /does not match next release 4\.20\.1/);

const tagged = api.resolveFromFacts({ headTags: ['v4.20.0', 'v4.20.1'], latestTag: 'v4.20.1', commits: [] });
assert.strictEqual(tagged.new_tag, 'v4.20.1');
assert.strictEqual(tagged.bump, 'tagged');

const skipped = api.resolveFromFacts({ latestTag: 'v4.20.1', commits: ['docs: note'] });
assert.strictEqual(skipped.skip, true);
assert.deepStrictEqual(api.checkDeclaredVersion(skipped, '4.20.1').ok, true);

assert.strictEqual(api.resolveFromFacts({ latestTag: 'v4.20.0', commits: ['fix: one'] }).new_tag, 'v4.20.1');
assert.strictEqual(api.resolveFromFacts({ latestTag: 'v4.20.1', commits: ['fix: two'] }).new_tag, 'v4.20.2');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-release-version-'));
try {
  git(repo, ['init', '-q']);
  for (const [key, value] of [['commit.gpgsign', 'false'], ['tag.gpgSign', 'false'], ['core.autocrlf', 'false']]) git(repo, ['config', key, value]);
  git(repo, ['config', 'user.email', 'forge@example.invalid']);
  git(repo, ['config', 'user.name', 'Forge Test']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'chore: base']);
  git(repo, ['tag', 'v1.2.3']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n');
  git(repo, ['add', 'a.txt']);
  git(repo, ['commit', '-q', '-m', 'feat: api', '-m', 'BREAKING CHANGE: removed field']);
  assert.strictEqual(api.resolveVersion(repo).new_tag, 'v2.0.0');
  const nestedArchive = path.join(repo, 'vendor', 'forge-agent-4.20.7');
  fs.mkdirSync(nestedArchive, { recursive: true });
  assert.throws(() => api.resolveVersion(nestedArchive), error => error.code === 'version-not-git');
  assert.strictEqual(product.archiveVersion(nestedArchive), '4.20.7');
  const shallow = `${repo}-shallow`;
  const cloned = spawnSync('git', ['clone', '-q', '--depth', '1', '--no-tags', `file:///${repo.replace(/\\/g, '/')}`, shallow],
    { encoding: 'utf8', shell: false });
  assert.strictEqual(cloned.status, 0, cloned.stderr);
  assert.throws(() => api.resolveVersion(shallow), error => error.code === 'version-history-incomplete');
  fs.rmSync(shallow, { recursive: true, force: true });
} finally { fs.rmSync(repo, { recursive: true, force: true }); }

console.log('forge-release-version tests passed');

let checks = 0;
function check(name, fn) {
  try { fn(); console.log(`ok ${++checks} - ${name}`); }
  catch (error) { console.error(`not ok ${++checks} - ${name}`); throw error; }
}

function gitText(cwd, args, input) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, input });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function withRepo(fn, tagged = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-version-contract-'));
  try {
    gitText(cwd, ['init', '-q']);
    for (const [key, value] of [['commit.gpgsign', 'false'], ['tag.gpgSign', 'false'], ['core.autocrlf', 'false'],
      ['user.email', 'forge@example.invalid'], ['user.name', 'Forge Test']]) gitText(cwd, ['config', key, value]);
    commit(cwd, 'chore: base');
    if (tagged) gitText(cwd, ['tag', 'v1.2.3']);
    fn(cwd);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

function commit(cwd, message) {
  gitText(cwd, ['-c', 'commit.cleanup=verbatim', 'commit', '-q', '--allow-empty', '-F', '-'], message);
  return gitText(cwd, ['rev-parse', 'HEAD']);
}

const sha = 'a'.repeat(40);
const removal = 'fix: x\n\nForge-Impact: cli/removal; --old-flag';
const corrected = 'fix: x\n\nForge-Impact: cli/compatible-correction; --flag';
const record = message => ({ sha, message });
const code = expected => error => error.code === expected;

check('CHECK-VERSION-LEGACY-PRESERVED', () => {
  // Os asserts históricos acima continuam ativos, incluindo shallow/ancestral.
  assert.strictEqual(api.bumpFor([42, null, {}, 'fix: bug']), 'patch');
  assert.throws(() => api.resolveFromFacts({ headTags: ['vbanana'], commits: [removal] }), code('invalid-release-tag'));
});

check('CHECK-VERSION-DECLARED-RETURN-SHAPE', () => {
  const resolution = api.resolveFromFacts({ latestTag: 'v1.2.3', commits: [record(corrected)] });
  assert.strictEqual(resolution.impact.status, 'consistent');
  assert.deepStrictEqual(api.checkDeclaredVersion(resolution, '1.2.4'), { ok: true, declared: '1.2.4', expected: '1.2.4', skip: false, bump: 'patch' });
});

check('CHECK-VERSION-CLASSIFIER-PARITY', () => {
  const titles = { major: 'Breaking Changes', minor: 'Features', patch: 'Bug Fixes', none: 'Other Changes' };
  for (const [message, bump] of [['BREAKING CHANGE: x', 'major'], ['feat!: x', 'major'],
    ['feat: x\n\nBREAKING CHANGE: x', 'major'], ['fix: x\n\nBREAKING-CHANGE: x', 'major'],
    ['feat(core(x)): x', 'minor'], ['fix(core(x)): x', 'patch'], ['docs: x', 'none'], ['FEAT: x', 'none']]) {
    assert.strictEqual(api.classifyCommit(message), bump);
    assert.strictEqual(api.bumpFor([message]), bump);
    assert(api.renderChangelog([record(message)]).startsWith(`### ${titles[bump]}\n\n`));
  }
});

check('CHECK-VERSION-CHANGELOG-FORMAT', () => {
  assert.strictEqual(api.renderChangelog(['feat!: a', 'feat: b', 'fix: c', 'docs: d'].map(record)),
    '### Breaking Changes\n\n- feat!: a (aaaaaaa)\n\n### Features\n\n- feat: b (aaaaaaa)\n\n### Bug Fixes\n\n- fix: c (aaaaaaa)\n\n### Other Changes\n\n- docs: d (aaaaaaa)\n');
  assert.strictEqual(api.renderChangelog([record('feat: first\nsecond\n\nBREAKING CHANGE: x')]),
    '### Breaking Changes\n\n- feat: first second (aaaaaaa)\n');
  assert(api.renderChangelog([record(corrected)]).includes('[impacto: cli/compatible-correction]'));
  assert.throws(() => api.renderChangelog([{ sha: `${sha}\n`, message: 'fix: x' }]), code('changelog-record-invalid'));
  assert.strictEqual(api.renderChangelog([]), '');
});

check('CHECK-VERSION-IMPACT-NO-THROW', () => {
  const resolution = api.resolveFromFacts({ latestTag: 'v1.2.3', commits: [42, null, {}, 'fix: x'] });
  assert.strictEqual(resolution.bump, 'patch');
  assert.strictEqual(resolution.impact.status, 'invalid');
  const tiny = api.resolveFromFacts({ latestTag: 'v1.2.3', commits: ['fix: x'] }, { impactOptions: { limits: { max_result_bytes: 1 } } });
  assert.strictEqual(tiny.bump, 'patch');
  assert.strictEqual(tiny.impact.status, 'invalid');
  assert.strictEqual(tiny.impact.reason, 'impact-result-too-large');
  for (const [errorCode, reason] of [['impact-input-invalid', 'impact-input-invalid'], ['unexpected', 'impact-evaluation-failed']]) {
    const impactOptions = { get limits() { throw Object.assign(new Error('seam'), { code: errorCode }); } };
    const result = api.resolveFromFacts({ latestTag: 'v1.2.3', commits: [record(corrected)] }, { impactOptions });
    assert.strictEqual(result.new_tag, 'v1.2.4');
    assert.strictEqual(result.impact.status, 'invalid');
    assert.strictEqual(result.impact.reason, reason);
  }
});

check('CHECK-VERSION-IMPACT-CONFLICT', () => withRepo(cwd => {
  const id = commit(cwd, removal);
  const resolution = api.resolveVersion(cwd);
  assert.strictEqual(resolution.bump, 'patch');
  assert.strictEqual(resolution.impact.status, 'conflict');
  assert.throws(() => api.checkDeclaredVersion(resolution, '1.2.4'), error =>
    error.code === 'impact-label-conflict' && error.message.startsWith('impact-label-conflict:') &&
    error.message.includes(id.slice(0, 7)) && error.message.includes('cli/removal') && error.message.includes('patch'));
}));

check('CHECK-VERSION-CONFLICT-RESOLVED', () => withRepo(cwd => {
  commit(cwd, removal);
  commit(cwd, 'chore: declarar\n\nBREAKING CHANGE: remove --old-flag');
  const resolution = api.resolveVersion(cwd);
  assert.strictEqual(resolution.new_tag, 'v2.0.0');
  assert.strictEqual(api.checkDeclaredVersion(resolution, '2.0.0').ok, true);
}));

check('CHECK-VERSION-IMPACT-INVALID', () => withRepo(cwd => {
  commit(cwd, 'fix: x\n\nForge-Impact: malformed');
  const resolution = api.resolveVersion(cwd);
  assert.strictEqual(resolution.impact.status, 'invalid');
  assert.throws(() => api.checkDeclaredVersion(resolution, '1.2.4'), code('impact-invalid'));
}));

check('CHECK-VERSION-STATUS-PRECEDENCE', () => {
  const resolution = api.resolveFromFacts({ latestTag: 'v1.2.3', commits: [record(`${removal}\nForge-Impact: malformed`)] });
  assert.throws(() => api.checkDeclaredVersion(resolution, '1.2.4'), error => error.code === 'impact-invalid' && error.message.includes('conflitos: 1'));
  assert.throws(() => api.checkDeclaredVersion(resolution, '1.2.3'), code('declared-version-mismatch'));
  const many = api.resolveFromFacts({ latestTag: 'v1.2.3', commits: Array(40).fill(record(removal)) });
  assert.throws(() => api.checkDeclaredVersion(many, '1.2.4'), error => error.message.includes('+72 omitidos') && error.message.length < 1500);
});

check('CHECK-VERSION-DECLARED-MISMATCH', () => {
  assert.throws(() => api.checkDeclaredVersion(next, '4.20.0'), error => error.code === 'declared-version-mismatch' &&
    error.message === 'product VERSION 4.20.0 does not match next release 4.20.1; bump scripts/forge-version.js and regenerate its golden/literal consumers');
});

check('CHECK-VERSION-HEAD-TAG-PRECEDENCE', () => withRepo(cwd => {
  commit(cwd, removal); gitText(cwd, ['tag', 'v1.2.4']);
  const resolution = api.resolveVersion(cwd);
  assert.strictEqual(resolution.bump, 'tagged');
  assert.strictEqual(resolution.impact.status, 'not-evaluated');
  assert.strictEqual(api.checkDeclaredVersion(resolution, '1.2.4').ok, true);
}));

check('CHECK-VERSION-NO-TAGS', () => withRepo(cwd => {
  commit(cwd, 'feat: x');
  const resolution = api.resolveVersion(cwd);
  assert.strictEqual(resolution.new_tag, 'v0.1.0');
  assert.strictEqual(resolution.range, 'HEAD');
  assert.strictEqual(resolution.impact.status, 'partial');
}, false));

check('CHECK-VERSION-RECEIPT-INTENT', () => {
  assert.deepStrictEqual(api.checkDeclaredVersion({ new_tag: 'v1.2.3', skip: true }, '1.2.3'),
    { ok: true, declared: '1.2.3', expected: '1.2.3', skip: true, bump: undefined });
});

check('CHECK-VERSION-PUBLISH-CONSUMER-SHAPE', () => {
  const resolution = api.resolveFromFacts({ latestTag: 'v1.2.3', commits: [record(corrected)] });
  assert.strictEqual(api.checkDeclaredVersion(resolution, '1.2.4').ok, true);
  assert.strictEqual(api.checkDeclaredVersion({ new_tag: resolution.new_tag, skip: resolution.skip }, '1.2.4').ok, true);
});

check('CHECK-VERSION-READER-RANGE-GRAMMAR', () => {
  let spawns = 0;
  for (const range of ['--output=x', '--all', 'HEAD:path', 'v1.0.0..HEAD\n--all', 'v1.0.0...HEAD', '-n1', 'v1.0.0', 'HEAD\n', 'v1.0.0..HEAD\n', '']) {
    assert.throws(() => api.readCommits('.', range, { spawnSync() { spawns++; } }), code('version-range-invalid'));
  }
  assert.strictEqual(spawns, 0);
});

check('CHECK-VERSION-READER-FRAMING', () => withRepo(cwd => {
  const message = 'fix: framing\r\n\r\nbody\x1e\x1f\r\n\r\nForge-Impact: cli/compatible-correction; --flag\r\n';
  const id = commit(cwd, message);
  const records = api.readCommits(cwd, 'v1.2.3..HEAD');
  assert.deepStrictEqual(records, [{ sha: id, message: message.trim() }]);
  assert.strictEqual(api.resolveVersion(cwd).impact.declared_commits, 1);
  assert.deepStrictEqual(api.readCommits(cwd, 'v1.2.3..HEAD', { spawnSync() { return { status: 0, stdout: '' }; } }), []);
}));

check('CHECK-VERSION-READER-MALFORMED-NUL', () => withRepo(cwd => {
  const parent = gitText(cwd, ['rev-parse', 'HEAD']);
  const tree = gitText(cwd, ['rev-parse', 'HEAD^{tree}']);
  const object = `tree ${tree}\nparent ${parent}\nauthor Forge <forge@example.invalid> 1000000000 +0000\ncommitter Forge <forge@example.invalid> 1000000000 +0000\n\nfix: before\0after\n`;
  const id = gitText(cwd, ['hash-object', '-t', 'commit', '--literally', '-w', '--stdin'], object);
  gitText(cwd, ['update-ref', 'HEAD', id]);
  const raw = spawnSync('git', ['-C', cwd, 'cat-file', 'commit', id], { shell: false });
  assert.strictEqual(raw.status, 0);
  assert(raw.stdout.includes(0));
  assert.throws(() => api.resolveVersion(cwd), code('version-commit-malformed'));
  const log = gitText(cwd, ['log', '-1', '--pretty=format:%B']);
  console.log(`info - git log NUL truncado: ${!log.includes('after')}`);
}));

check('CHECK-VERSION-READER-BOUNDS', () => {
  withRepo(cwd => {
    commit(cwd, 'fix: one'); commit(cwd, 'fix: two');
    assert.throws(() => api.readCommits(cwd, 'HEAD', { limits: { max_commits: 1 } }), code('version-history-too-large'));
  });
  assert.throws(() => api.readCommits('.', 'HEAD', { spawnSync() { return { error: Object.assign(new Error('ENOBUFS'), { code: 'ENOBUFS' }) }; } }), code('version-history-unreadable'));
  const body = Buffer.from('tree x\n\n');
  const framed = (content, header = `${sha} commit ${content.length}`) => Buffer.concat([Buffer.from(`${header}\n`), content, Buffer.from('\n')]);
  let captured;
  function seam(output, options = {}) {
    return { ...options, spawnSync(exe, args, opts) {
      assert.strictEqual(exe, 'git'); assert.strictEqual(opts.shell, false); assert(opts.maxBuffer > 0);
      if (args.includes('rev-list')) return { status: 0, stdout: `${sha}\n` };
      captured = opts;
      return { status: 0, stdout: output };
    } };
  }
  assert.deepStrictEqual(api.readCommits('.', 'HEAD', seam(framed(body))), [{ sha, message: '' }]);
  assert.strictEqual(captured.maxBuffer, api.COMMIT_LIMITS.max_bytes + api.COMMIT_LIMITS.max_commits * 100);
  const malformed = [Buffer.from('missing\n'), framed(body, `${sha} tree ${body.length}`),
    framed(body, `${'b'.repeat(40)} commit ${body.length}`), framed(body, `${sha} commit 1`),
    framed(body, `${sha} commit ${body.length + 1}`), framed(body).subarray(0, -1),
    Buffer.concat([framed(body), Buffer.from('extra')]), framed(Buffer.from([0xff])),
    framed(Buffer.concat([body, Buffer.from([0xc3, 0x28])])), framed(Buffer.from('no separator')),
    framed(body, `${sha} commit -1`), framed(body, `${sha} commit 9007199254740992`)];
  for (const output of malformed) assert.throws(() => api.readCommits('.', 'HEAD', seam(output)), code('version-commit-malformed'));
  assert.throws(() => api.readCommits('.', 'HEAD', seam(framed(body), { limits: { max_bytes: body.length - 1 } })), code('version-history-too-large'));
  // Soma de vários objetos acima do teto, mesmo com exit 0 e cada objeto abaixo dele.
  let calls = 0;
  assert.throws(() => api.readCommits('.', 'HEAD', { limits: { max_bytes: body.length * 2 - 1 }, spawnSync() {
    return ++calls === 1 ? { status: 0, stdout: `${sha}\n${sha}\n` } : { status: 0, stdout: Buffer.concat([framed(body), framed(body)]) };
  } }), code('version-history-too-large'));
  assert.throws(() => api.readCommits('.', 'HEAD', { spawnSync() {
    return { status: 1, stdout: '', stderr: 'failure' };
  } }), code('version-history-unreadable'));
  assert.throws(() => api.readCommits('.', 'HEAD', { spawnSync(exe, args) {
    return args.includes('rev-list') ? { status: 0, stdout: `${sha}\n` } : { status: 0, error: new Error('ENOBUFS') };
  } }), code('version-history-unreadable'));
  const sha64 = 'b'.repeat(64);
  assert.deepStrictEqual(api.readCommits('.', 'HEAD', { spawnSync(exe, args) {
    return args.includes('rev-list') ? { status: 0, stdout: `${sha64}\n` }
      : { status: 0, stdout: framed(body, `${sha64} commit ${body.length}`) };
  } }), [{ sha: sha64, message: '' }]);
});

check('CHECK-VERSION-CLI-NOTES-AND-EXIT', () => withRepo(cwd => {
  fs.mkdirSync(path.join(cwd, 'scripts'));
  for (const file of ['forge-release-version.js', 'forge-release-impact.js', 'forge-version.js']) fs.copyFileSync(path.join(__dirname, file), path.join(cwd, 'scripts', file));
  const cli = args => spawnSync(process.execPath, [path.join(cwd, 'scripts/forge-release-version.js'), ...args], { cwd, shell: false, encoding: 'utf8' });
  const notes = path.join(cwd, 'notes.md'); const output = path.join(cwd, 'output');
  commit(cwd, 'feat: x\n\nBREAKING CHANGE: x');
  fs.writeFileSync(path.join(cwd, 'VERSION'), '2.0.0');
  const success = cli(['--check', '--github-output', output, '--notes', notes]);
  assert.strictEqual(success.status, 0, success.stderr);
  assert(fs.readFileSync(notes, 'utf8').startsWith('### Breaking Changes'));
  assert.strictEqual(JSON.parse(success.stdout).new_tag, 'v2.0.0');
  assert.strictEqual(fs.readFileSync(output, 'utf8'), 'new_tag=v2.0.0\nskip=false\nrange=v1.2.3..HEAD\nbump=major\n');
  const original = fs.readFileSync(notes);
  const failedNotes = cli(['--github-output', output, '--notes', notes]);
  assert.notStrictEqual(failedNotes.status, 0);
  assert.strictEqual(failedNotes.stdout, '');
  assert.strictEqual(fs.readFileSync(output, 'utf8').split('new_tag=').length, 3);
  assert.deepStrictEqual(fs.readFileSync(notes), original);
  const missing = cli(['--notes']);
  assert.notStrictEqual(missing.status, 0);
  assert.strictEqual(missing.stderr.trim(), 'forge-release-version: --notes requires a file');
  fs.writeFileSync(path.join(cwd, 'VERSION'), '1.2.3');
  const mismatch = cli(['--check']);
  assert.notStrictEqual(mismatch.status, 0);
  assert(mismatch.stderr.startsWith('forge-release-version: product VERSION 1.2.3 does not match next release 2.0.0;'));
  gitText(cwd, ['tag', 'v2.0.0']); commit(cwd, removal);
  fs.writeFileSync(path.join(cwd, 'VERSION'), '2.0.1');
  const blockedNotes = path.join(cwd, 'blocked.md'); const blockedOutput = path.join(cwd, 'blocked-output');
  const conflict = cli(['--check', '--github-output', blockedOutput, '--notes', blockedNotes]);
  assert.notStrictEqual(conflict.status, 0);
  assert(conflict.stderr.startsWith('forge-release-version: impact-label-conflict:'));
  assert.strictEqual(conflict.stdout, '');
  assert(!fs.existsSync(blockedNotes)); assert(!fs.existsSync(blockedOutput));
}));

check('CHECK-VERSION-ROOT-TAG-FALLBACK', () => withRepo(cwd => {
  assert.deepStrictEqual(api.collectNotesCommits(cwd, api.resolveVersion(cwd)), api.readCommits(cwd, 'HEAD'));
  assert.throws(() => api.collectNotesCommits(cwd, { range: 'v9.9.9^..HEAD' }), error => error.code === 'changelog-range-unavailable' && error.cause.code === 'version-history-unreadable');
  commit(cwd, 'fix: nonroot'); gitText(cwd, ['tag', 'v1.2.4']);
  let fallback = false;
  assert.throws(() => api.collectNotesCommits(cwd, { range: 'v1.2.4^..HEAD' }, { spawnSync(exe, args, options) {
    if (args.includes('HEAD')) fallback = true;
    if (args.includes('--parents')) return spawnSync(exe, args, options);
    return { status: 1, stderr: 'failure' };
  } }), code('changelog-range-unavailable'));
  assert.strictEqual(fallback, false);
}));
