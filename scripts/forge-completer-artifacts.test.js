#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { actualAddedModified } = require('./forge-completer-artifacts.js');
const root = path.join(__dirname, '..');
let passed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`  not ok  ${name}: ${error.message}`); process.exitCode = 1; }
}
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

test('SVN-005 responsive fast mode uses the VCS seam and has no Git-only command', () => {
  const text = read('skills/forge-responsive/SKILL.md');
  assert.match(text, /forge-completer-artifacts\.js.*--actual-am/);
  assert.ok(!text.includes('git diff --name-only main'));
});

test('SVN-006 probe completion branches by detected backend and never commits SVN with Git', () => {
  const text = read('skills/forge-probe/SKILL.md');
  assert.match(text, /PROBE_VCS=.*forge-vcs\.js.*--detect.*--field vcs/);
  assert.match(text, /SVN working copy.*uncommitted/i);
  assert.ok(!/if \[ "\$AUTO_COMMIT" = "true" \]; then\s+git add/.test(text));
});

test('SVN-007 completer file audit delegates to a VCS-aware helper and fails honestly', () => {
  const text = read('shared/forge-completer-slice.md');
  assert.match(text, /forge-completer-artifacts\.js.*--actual-am/);
  assert.match(text, /file-audit-unavailable/);
  assert.ok(!text.includes('git failure silently yields an empty set'));
});

test('SVN-007 live no-Git WC returns only added/modified paths', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-completer-svn-'));
  try {
    const repo = path.join(rootDir, 'repo');
    const seed = path.join(rootDir, 'seed');
    const wc = path.join(rootDir, 'wc');
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'tracked.txt'), 'base\n');
    execFileSync('svnadmin', ['create', repo]);
    const url = `file:///${repo.replace(/\\/g, '/')}`;
    execFileSync('svn', ['import', seed, url, '-m', 'initial import', '--quiet']);
    execFileSync('svn', ['checkout', url, wc, '--quiet']);
    fs.appendFileSync(path.join(wc, 'tracked.txt'), 'changed\n');
    fs.writeFileSync(path.join(wc, 'new.txt'), 'new\n');
    assert.ok(!fs.existsSync(path.join(wc, '.git')));
    assert.deepStrictEqual(actualAddedModified(wc), { vcs: 'svn', ok: true, paths: ['new.txt', 'tracked.txt'], scope: 'working-copy' });
  } finally { fs.rmSync(rootDir, { recursive: true, force: true }); }
});

test('SVN-007 helper preserves Git branch and untracked file audit behavior', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-completer-git-'));
  try {
    execFileSync('git', ['init', '-b', 'master'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'forge@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base', '--quiet'], { cwd: repo });
    execFileSync('git', ['switch', '-c', 'forge/test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'committed.txt'), 'committed\n');
    execFileSync('git', ['add', 'committed.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feature', '--quiet'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
    assert.deepStrictEqual(actualAddedModified(repo), {
      vcs: 'git', ok: true, paths: ['committed.txt', 'untracked.txt'], scope: 'branch',
    });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Git file audit fails honestly when develop has no origin/HEAD or canonical base', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-completer-git-develop-'));
  try {
    execFileSync('git', ['init', '-b', 'develop'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'forge@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base', '--quiet'], { cwd: repo });
    execFileSync('git', ['switch', '-c', 'forge/test'], { cwd: repo });
    assert.deepStrictEqual(actualAddedModified(repo), {
      vcs: 'git', ok: false, paths: [], error: 'file-audit-unavailable:git:no-base',
    });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Git file audit accepts an explicit run base for non-canonical branch names', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-completer-git-explicit-'));
  try {
    execFileSync('git', ['init', '-b', 'develop'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'forge@example.invalid'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'base', '--quiet'], { cwd: repo });
    execFileSync('git', ['switch', '-c', 'forge/test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
    execFileSync('git', ['add', 'feature.txt'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'feature', '--quiet'], { cwd: repo });
    assert.deepStrictEqual(actualAddedModified(repo, { baseRef: 'develop' }), {
      vcs: 'git', ok: true, paths: ['feature.txt'], scope: 'branch',
    });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('SVN-007 no-VCS CLI exits unavailable, never empty-success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-completer-none-'));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-completer-artifacts.js'), '--actual-am', '--cwd', dir], { encoding: 'utf8' });
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /file-audit-unavailable:none/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

process.on('exit', () => console.log(`\n${passed} passed`));
