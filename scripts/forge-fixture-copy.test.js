'use strict';
const assert = require('assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { createFixtureHarness } = require('./fixtures/forge-native-execution');
const harness = createFixtureHarness();
let completed = false;
function inventory(root) {
  const result = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), relative = path.relative(root, file);
      assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) { result[relative + '/'] = 'directory'; visit(file); }
      else result[relative] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  visit(root); return result;
}
try {
  const first = harness.setup(), second = harness.setup();
  const template = path.join(harness.root, 'git-template');
  const objects = inventory(path.join(template, '.git/objects'));
  assert(Object.keys(objects).some(name => !name.endsWith('/')));
  for (const fixture of [first, second]) {
    assert.deepEqual(inventory(path.join(fixture.cwd, '.git/objects')), objects);
    assert.equal(harness.git(fixture.cwd, ['rev-parse', 'HEAD']), harness.git(template, ['rev-parse', 'HEAD']));
    assert.equal(harness.git(fixture.cwd, ['status', '--porcelain']), 'M dirty.txt');
    harness.git(fixture.cwd, ['fsck', '--full']);
  }
  fs.writeFileSync(path.join(first.cwd, 'src.js'), 'independent commit\n');
  harness.git(first.cwd, ['add', 'src.js']);
  harness.git(first.cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'independent']);
  assert.notEqual(harness.git(first.cwd, ['rev-parse', 'HEAD']), harness.git(second.cwd, ['rev-parse', 'HEAD']));
  assert.deepEqual(inventory(path.join(second.cwd, '.git/objects')), objects);
  assert.deepEqual(inventory(path.join(template, '.git/objects')), objects);
  const original = fs.cpSync;
  const failure = Object.assign(new Error('injected fixture copy failure'), { code: 'ENOENT' });
  let calls = 0;
  try {
    fs.cpSync = () => { calls++; throw failure; };
    assert.throws(() => harness.setup(), error => error === failure);
    assert.equal(calls, 1);
  } finally { fs.cpSync = original; }
  completed = true;
  console.log('PASS fixture copy: complete Git objects, valid independent repositories, dirty baseline and no swallowed/retried errors');
} finally { harness.close(completed); }
