#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vcs = require('./forge-vcs.js');
const labApi = require('./forge-svn-lab.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; process.stdout.write(`  ok  ${name}\n`); }
  catch (error) { process.stderr.write(`  FAIL ${name}: ${error.stack || error}\n`); process.exitCode = 1; }
}
function refuses(fn, code) { assert.throws(fn, (error) => error.message.includes(code)); }

const lab = labApi.createLab();
try {
  test('root is outside the corporate SVN tree', () => {
    assert(!path.resolve(lab.root).toLowerCase().startsWith(path.resolve('C:\\SVN').toLowerCase() + path.sep));
  });
  test('root, parent, sibling-prefix and dot-dot escapes are refused', () => {
    refuses(() => labApi.guardTarget(lab.root, lab.root), 'not-strict-descendant');
    refuses(() => labApi.guardTarget(lab.root, path.dirname(lab.root)), 'not-strict-descendant');
    refuses(() => labApi.guardTarget(lab.root, `${lab.root}-sibling`), 'not-strict-descendant');
    refuses(() => labApi.guardTarget(lab.root, path.join(lab.root, 'wc', '..', '..', 'escape')), 'not-strict-descendant');
  });
  test('unmanifested child is refused', () => refuses(() => labApi.guardTarget(lab.root, path.join(lab.root, 'other', 'x')), 'not-manifested'));
  test('missing and mismatched ownership proof is refused', () => {
    const marker = path.join(lab.root, labApi.MARKER);
    const original = fs.readFileSync(marker, 'utf8');
    fs.rmSync(marker);
    refuses(() => labApi.guardTarget(lab.root, path.join(lab.root, 'wc', 'x')), 'proof-missing');
    fs.writeFileSync(marker, original.replace(lab.nonce, 'wrong'));
    refuses(() => labApi.guardTarget(lab.root, path.join(lab.root, 'wc', 'x')), 'proof-mismatch');
    fs.writeFileSync(marker, original);
  });
  test('symlink or junction traversal is refused when supported', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-svn-outside-'));
    const link = path.join(lab.wc, 'link');
    try {
      try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error; }
      refuses(() => labApi.guardTarget(lab.root, path.join(link, 'victim')), 'reparse-point');
    } finally { if (fs.existsSync(link)) fs.unlinkSync(link); fs.rmSync(outside, { recursive: true }); }
  });
  test('local SVN lifecycle uses file URL and a WC without .git', () => {
    const checkout = labApi.initializeSvn(lab);
    assert.strictEqual(checkout.exit, 0);
    assert(!fs.existsSync(path.join(lab.wc, '.git')));
  });
  test('regression SVN-001: restoreAndRemove reverts a versioned @ path', () => {
    const atFile = path.join(lab.wc, 'service@1.2.0.txt');
    fs.writeFileSync(atFile, 'base\n');
    assert.strictEqual(labApi.run(['svn', '--non-interactive', '--config-dir', lab.config, 'add', `${atFile}@`], { cwd: lab.wc }).exit, 0);
    assert.strictEqual(labApi.run(['svn', '--non-interactive', '--config-dir', lab.config, 'commit', '-m', 'fixture', lab.wc], { cwd: lab.wc }).exit, 0);
    fs.writeFileSync(atFile, 'changed\n');
    const result = vcs.restoreAndRemove(lab.wc, '1', { restore: ['service@1.2.0.txt'], remove: [], overlap: [], preserved: [] }, { vcs: 'svn', configDir: lab.config });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(fs.readFileSync(atFile, 'utf8'), 'base\n');
  });
  test('failed probe preserves lab and ownership evidence', () => {
    assert(fs.existsSync(lab.root));
    assert(fs.existsSync(path.join(lab.root, labApi.MARKER)));
    assert(fs.existsSync(path.join(lab.root, labApi.MANIFEST)));
  });
  test('cleanup removes only manifested children and preserves root proof', () => {
    const result = labApi.cleanupChildren(lab);
    assert.strictEqual(result.preserved_root, lab.root);
    for (const child of labApi.CHILDREN) assert(!fs.existsSync(path.join(lab.root, child)));
    assert(fs.existsSync(path.join(lab.root, labApi.MARKER)));
  });
} finally {
  process.stdout.write(`\n${passed} passed\nLAB_ROOT=${lab.root}\n`);
}
if (process.exitCode) process.exit(process.exitCode);
