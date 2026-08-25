'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const guard = require('./forge-sensitive-term-guard');

const forbidden = Buffer.from([87, 68, 77, 65]);
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-term-guard-'));
  git(root, ['init', '-q']);
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  git(root, ['add', '.']);
  return root;
}
function withRepo(files, fn) {
  const root = repo(files);
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('accepts a clean tracked tree', () => withRepo({ 'ok.bin': Buffer.from([0, 1, 2]) }, root => {
  assert.deepStrictEqual(guard.scanTracked(root), { files: 1, matches: [] });
}));
test('rejects content in any ASCII case', () => withRepo({ 'bad.bin': Buffer.from(forbidden.toString().toLowerCase()) }, root => {
  assert.throws(() => guard.assertClean(root), /forbidden bytes in tracked content/);
}));
test('rejects a tracked path', () => withRepo({ [`x-${forbidden.toString()}-x.txt`]: 'clean' }, root => {
  assert.throws(() => guard.assertClean(root), /forbidden bytes in tracked path/);
}));
test('scans binary bytes without decoding', () => withRepo({ 'binary.dat': Buffer.concat([Buffer.from([0xff, 0]), forbidden]) }, root => {
  assert.throws(() => guard.assertClean(root), /tracked content/);
}));
test('fails closed outside Git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-term-no-git-'));
  try { assert.throws(() => guard.scanTracked(root), /git ls-files failed/); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('fails closed when a listed file cannot be read', () => withRepo({ 'gone.txt': 'clean' }, root => {
  fs.unlinkSync(path.join(root, 'gone.txt'));
  assert.throws(() => guard.scanTracked(root), /cannot read tracked file/);
}));

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); process.stdout.write(`ok - ${name}\n`); }
  catch (error) { failed++; process.stderr.write(`not ok - ${name}\n${error.stack}\n`); }
}
if (failed) process.exitCode = 1;
