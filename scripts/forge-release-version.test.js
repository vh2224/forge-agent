#!/usr/bin/env node
'use strict';

const assert = require('assert');
const api = require('./forge-release-version.js');

assert.strictEqual(api.bumpFor(['docs: note', 'fix(core): bug']), 'patch');
assert.strictEqual(api.bumpFor(['fix: bug', 'feat(core): capability']), 'minor');
assert.strictEqual(api.bumpFor(['feat!: break']), 'major');
assert.strictEqual(api.bumpFor(['docs: note']), 'none');
assert.strictEqual(api.nextTag('v4.19.6', 'minor'), 'v4.20.0');
assert.strictEqual(api.nextTag('v4.20.0', 'patch'), 'v4.20.1');

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

console.log('forge-release-version tests passed');
