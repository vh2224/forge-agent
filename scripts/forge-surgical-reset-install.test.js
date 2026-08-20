#!/usr/bin/env node
'use strict';

/* S03/W4: an install-sized artifact set must be excluded by name, counted, and
 * must not weaken the pre-existing-work overlap guard. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const reset = require('./forge-surgical-reset.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

// The vendored file is the R6 fixture: a path that matches the install predicate
// AND is under version control. It must behave like ordinary tracked content.
const VENDORED = 'node_modules/vendored/keep.js';
const VENDORED_BASELINE = 'module.exports = "vendored baseline";\n';

function makeRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-install-'));
  git(cwd, ['init', '-q']);
  // Pin EOL handling: the windows-latest runner's Git ships a global
  // core.autocrlf=true, so executeReset's checkout-based restore rewrote the
  // LF VENDORED_BASELINE as CRLF and both the byte-for-byte restore assert
  // and verifyReset went red on Windows only. Repo-local config outranks the
  // global one.
  //
  // KNOWN PRODUCTION LIMITATION, now DECLARED rather than tracked (#104,
  // decided 2026-08-19 as option 3): the surgical reset restores via plain
  // `git checkout`, so for a real Windows user with autocrlf=true restored
  // files come back CRLF-normalized. Passing `-c core.autocrlf=false` was
  // REJECTED — it changes what the user's working tree contains after a reset.
  // The behaviour stays; the reset now WARNS when that configuration is in
  // force. This pin only makes the fixture deterministic.
  git(cwd, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'baseline\n');
  fs.mkdirSync(path.join(cwd, 'node_modules', 'vendored'), { recursive: true });
  fs.writeFileSync(path.join(cwd, VENDORED), VENDORED_BASELINE);
  // -f because a global/ambient .gitignore commonly ignores node_modules — which is
  // exactly how a real repo vendors a dependency, and why porcelain never reports
  // the untracked install volume around it.
  git(cwd, ['add', 'tracked.txt']);
  git(cwd, ['add', '-f', VENDORED]);
  git(cwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'init']);
  return cwd;
}

const cwd = makeRepo();
try {
  const baseline = git(cwd, ['rev-parse', 'HEAD']);
  const dirtyContent = 'operator work must survive\0\n';
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), dirtyContent, 'utf8');
  const preDirty = reset.captureSnapshot(cwd);
  const preHash = preDirty.find((entry) => entry.path === 'tracked.txt').hash;

  const modules = path.join(cwd, 'node_modules');
  for (let i = 0; i < 1500; i += 1) {
    const packageDir = path.join(modules, `pkg-${String(i % 25).padStart(2, '0')}`);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, `file-${i}.js`), `module.exports = ${i};\n`);
  }
  fs.mkdirSync(path.join(modules, 'nested', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(modules, 'nested', 'pkg', 'deep.js'), 'nested install artifact\n');
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.gsd', 'x'), 'orchestrator data\n');
  fs.writeFileSync(path.join(cwd, 'sidecar-one.txt'), 'sidecar\n');
  fs.writeFileSync(path.join(cwd, 'sidecar-two.txt'), 'sidecar\n');
  // The sidecar also modifies the TRACKED vendored file (R6).
  fs.writeFileSync(path.join(cwd, VENDORED), 'module.exports = "sidecar clobbered this";\n');

  test('named predicate covers root and nested install artifacts without covering peers', () => {
    assert.strictEqual(reset.isInstallArtifactPath('node_modules/a.js'), true);
    assert.strictEqual(reset.isInstallArtifactPath('pkg/node_modules/a.js'), true);
    assert.strictEqual(reset.isInstallArtifactPath('node_modules\\a.js'), true);
    assert.strictEqual(reset.isInstallArtifactPath('node_modulesish/a.js'), false);
    assert.strictEqual(reset.isInstallArtifactPath('src/a.js'), false);
  });

  const post = reset.computePostChanges(cwd, baseline);
  assert.ok(post.excluded_install_artifacts > 0, 'install exclusion must be censusable');
  assert.ok(post.every((entry) => !reset.isInstallArtifactPath(entry.path) || entry.path === VENDORED),
    'only the TRACKED install path may enter the post diff');
  assert.ok(post.every((entry) => !reset.isGsdPath(entry.path)), '.gsd exclusion must remain active');

  test('the census counts each excluded install FILE exactly once', () => {
    // 1500 pkg files + 1 nested deep.js. Not >= 1500: that assertion could not tell
    // 1501 from 3002, which is what the porcelain census and the filesystem walk
    // summed to whenever node_modules was not gitignored (R7). Directories are not
    // counted, and the tracked vendored file is not an exclusion.
    assert.strictEqual(post.excluded_install_artifacts, 1501);
  });

  test('a TRACKED install path is restored, never silently excluded (R6)', () => {
    assert.ok(post.some((entry) => entry.path === VENDORED),
      'a tracked node_modules file modified by the sidecar must appear in the post diff');
    const target = reset.computeResetTarget(post, preDirty, (relPath) => reset.hashObject(cwd, relPath));
    assert.ok(target.restore.includes(VENDORED), 'it must be a restore target, not an exclusion');
    // And the untracked install volume around it is still excluded — the fix must not
    // have simply deleted the rule the 2026-06-10 incident put there.
    assert.ok(!target.restore.concat(target.remove).some((p) => p !== VENDORED && reset.isInstallArtifactPath(p)),
      'untracked install output must remain excluded');
  });

  test('volume install does not abort overlap calculation and census reports exclusion', () => {
    const target = reset.computeResetTarget(post, preDirty, (relPath) => reset.hashObject(cwd, relPath));
    assert.deepStrictEqual(target.overlap, []);
    assert.strictEqual(target.excluded_install_artifacts, 1501);
    assert.ok(target.remove.includes('sidecar-one.txt'));
    assert.ok(target.remove.includes('sidecar-two.txt'));
    assert.ok(!target.remove.some((relPath) => reset.isInstallArtifactPath(relPath)));
    assert.ok(!target.remove.includes('.gsd/x'));
  });

  const target = reset.computeResetTarget(post, preDirty, (relPath) => reset.hashObject(cwd, relPath));
  const done = reset.executeReset(cwd, baseline, target);

  test('executeReset removes sidecar files while preserving dirty work byte-for-byte', () => {
    assert.ok(done.removed.includes('sidecar-one.txt'));
    assert.ok(done.removed.includes('sidecar-two.txt'));
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), dirtyContent);
    assert.strictEqual(reset.hashObject(cwd, 'tracked.txt'), preHash);
    assert.ok(fs.existsSync(path.join(cwd, 'node_modules', 'pkg-00', 'file-0.js')));
    assert.strictEqual(fs.readFileSync(path.join(cwd, '.gsd', 'x'), 'utf8'), 'orchestrator data\n');
  });

  test('the tracked install path is restored byte-for-byte and verification inspects it', () => {
    assert.ok(done.restored.includes(VENDORED));
    assert.strictEqual(fs.readFileSync(path.join(cwd, VENDORED), 'utf8'), VENDORED_BASELINE);
    // verifyReset must be reporting on a tree it actually looked at: before the fix
    // this path was invisible to it, so verified:true said nothing about it.
    const check = reset.verifyReset(cwd, baseline, preDirty);
    assert.strictEqual(check.verified, true, JSON.stringify(check.leftover));
    fs.writeFileSync(path.join(cwd, VENDORED), 'clobbered again after the reset\n');
    const dirty = reset.verifyReset(cwd, baseline, preDirty);
    assert.strictEqual(dirty.verified, false, 'a tracked install path left divergent must fail verification');
    assert.ok(dirty.leftover.includes(VENDORED));
    fs.writeFileSync(path.join(cwd, VENDORED), VENDORED_BASELINE);
  });

  test('the discriminant is real: an ordinary sidecar path enters remove', () => {
    assert.ok(target.remove.includes('sidecar-one.txt'));
    assert.ok(!reset.isInstallArtifactPath('sidecar-one.txt'));
  });

  process.stdout.write(`\n${passed} passed, 0 failed\n`);
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}
