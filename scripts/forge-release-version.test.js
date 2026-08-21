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

const next = api.resolveFromFacts({ latestTag: 'v4.20.0', commits: ['fix(release): enforce version'] });
assert.deepStrictEqual(next, { skip: false, new_tag: 'v4.20.1', range: 'v4.20.0..HEAD', bump: 'patch', latest_tag: 'v4.20.0' });
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
} finally { fs.rmSync(repo, { recursive: true, force: true }); }

console.log('forge-release-version tests passed');
