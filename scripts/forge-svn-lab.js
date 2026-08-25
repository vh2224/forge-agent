#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const TASK_ID = 'T-20260824120158-auditar-validar';
const MARKER = '.forge-svn-lab-owner.json';
const MANIFEST = '.forge-svn-lab-manifest.json';
const CHILDREN = Object.freeze(['repo', 'svnconfig', 'wc', 'evidence']);

function realExistingParent(target) {
  let cursor = path.resolve(target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('lab-path-has-no-existing-parent');
    cursor = parent;
  }
  return fs.realpathSync.native(cursor);
}

function rejectReparseBetween(root, target) {
  let cursor = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  while (cursor !== resolvedRoot) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`lab-reparse-point:${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('lab-target-outside-root');
    cursor = parent;
  }
}

function readProof(root) {
  const markerPath = path.join(root, MARKER);
  const manifestPath = path.join(root, MANIFEST);
  if (!fs.existsSync(markerPath) || !fs.existsSync(manifestPath)) throw new Error('lab-proof-missing');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (marker.task_id !== TASK_ID || marker.nonce !== manifest.nonce || manifest.root !== path.resolve(root)) {
    throw new Error('lab-proof-mismatch');
  }
  if (!Array.isArray(manifest.children) || manifest.children.some((name) => !CHILDREN.includes(name))) {
    throw new Error('lab-manifest-invalid');
  }
  return { marker, manifest };
}

function guardTarget(root, target, options = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('lab-target-not-strict-descendant');
  }
  const first = relative.split(path.sep)[0];
  const proof = readProof(resolvedRoot);
  if (!proof.manifest.children.includes(first)) throw new Error('lab-target-not-manifested');
  rejectReparseBetween(resolvedRoot, resolvedTarget);
  const parentReal = realExistingParent(resolvedTarget);
  const rootReal = fs.realpathSync.native(resolvedRoot);
  const realRelative = path.relative(rootReal, parentReal);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error('lab-target-realpath-escape');
  }
  if (options.mustExist && !fs.existsSync(resolvedTarget)) throw new Error('lab-target-missing');
  return resolvedTarget;
}

function createLab(prefix = 'forge-svn-parity-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nonce = crypto.randomBytes(18).toString('hex');
  const marker = { task_id: TASK_ID, nonce, created_at: new Date().toISOString() };
  const manifest = { task_id: TASK_ID, nonce, root: path.resolve(root), children: [...CHILDREN] };
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  for (const child of CHILDREN) fs.mkdirSync(guardTarget(root, path.join(root, child)));
  return { root, nonce, repo: path.join(root, 'repo'), config: path.join(root, 'svnconfig'), wc: path.join(root, 'wc'), evidence: path.join(root, 'evidence') };
}

function run(argv, options = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('lab-argv-required');
  const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, encoding: 'utf8' });
  return { command: argv, exit: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function hasSvnToolchain() {
  for (const command of ['svn', 'svnadmin']) {
    const result = spawnSync(command, ['--version', '--quiet'], { encoding: 'utf8' });
    if (result.status !== 0) return false;
  }
  return true;
}

function initializeSvn(lab) {
  guardTarget(lab.root, lab.repo, { mustExist: true });
  let result = run(['svnadmin', 'create', lab.repo]);
  if (result.exit !== 0) throw new Error(`svnadmin-create-failed:${result.stderr.trim()}`);
  guardTarget(lab.root, lab.wc, { mustExist: true });
  result = run(['svn', '--non-interactive', '--config-dir', lab.config, 'checkout', pathToFileURL(lab.repo).href, lab.wc], { cwd: lab.root });
  if (result.exit !== 0) throw new Error(`svn-checkout-failed:${result.stderr.trim()}`);
  if (fs.existsSync(path.join(lab.wc, '.git'))) throw new Error('lab-wc-must-not-contain-git');
  return result;
}

function cleanupChildren(lab) {
  for (const child of [...CHILDREN].reverse()) {
    const target = guardTarget(lab.root, path.join(lab.root, child), { mustExist: true });
    fs.rmSync(target, { recursive: true, force: false });
  }
  return { preserved_root: lab.root, removed_children: [...CHILDREN].reverse() };
}

module.exports = { TASK_ID, MARKER, MANIFEST, CHILDREN, createLab, guardTarget, initializeSvn, cleanupChildren, run, hasSvnToolchain };

if (require.main === module) {
  const lab = createLab();
  initializeSvn(lab);
  process.stdout.write(JSON.stringify({ ok: true, root: lab.root, wc_has_git: fs.existsSync(path.join(lab.wc, '.git')) }) + '\n');
}
