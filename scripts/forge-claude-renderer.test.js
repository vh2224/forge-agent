#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const renderer = require('./forge-claude-renderer');

const repo = path.resolve(__dirname, '..');
const dirs = [];
function temp(label) { const value = fs.mkdtempSync(path.join(os.tmpdir(), `forge-claude-${label}-`)); dirs.push(value); return value; }
function fixtureRepo() {
  const root = temp('repo');
  for (const file of ['CLAUDE.md', 'scripts/forge-hook.js', 'shared/forge-mcps.md', 'shared/templates/claude/settings.jsonc', 'forge-capabilities.json', 'forge-prefs.schema.json']) {
    const source = path.join(repo, file);
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  for (const directory of ['agents', 'commands', 'skills', 'shared/templates/dispatch']) {
    fs.cpSync(path.join(repo, directory), path.join(root, directory), { recursive: true });
  }
  fs.copyFileSync(path.join(repo, 'forge-source-manifest.json'), path.join(root, 'forge-source-manifest.json'));
  return root;
}
function manifestFor(root) { return JSON.parse(fs.readFileSync(path.join(root, 'forge-source-manifest.json'), 'utf8')); }
function cleanup() { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); }

try {
  // Render twice and compare bytes: output is LF-only and independent of host separators.
  const root = fixtureRepo();
  const first = renderer.render({ repo: root, projectRoot: root, claudeHome: path.join(root, 'Claude Home Ω'), forgeHome: path.join(root, 'Forge Home Ω') });
  const second = renderer.render({ repo: root, projectRoot: root, claudeHome: path.join(root, 'Claude Home Ω'), forgeHome: path.join(root, 'Forge Home Ω') });
  assert.deepStrictEqual(first.artifacts, second.artifacts);
  assert(first.artifacts.some((item) => item.destination.endsWith(path.join('Claude Home Ω', 'agents', 'forge-executor.md'))));
  assert(first.artifacts.some((item) => item.destination.endsWith(path.join('CLAUDE.md'))));
  assert(first.artifacts.every((item) => !item.content.includes('\r')));
  assert(first.artifacts.find((item) => item.source === 'CLAUDE.md').content.startsWith('<!-- forge-source:claude-instructions'));
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-renderer', 'claude-4.8.0.golden.json'), 'utf8'));
  assert.strictEqual(golden.runtime, first.runtime);
  assert.strictEqual(golden.version, renderer.VERSION);
  for (const surface of golden.surfaces) {
    const matching = first.artifacts.filter((item) => item.source_id === surface.source_id);
    assert(matching.length > 0, `golden surface missing: ${surface.source_id}`);
    const target = surface.target.split(';')[0].replace(/^(?:project|forge)\//, '');
    const suffix = target.replace(/\//g, path.sep);
    const targetFound = matching.some((item) => item.destination.endsWith(suffix)
      || item.destination.includes(`${path.sep}${suffix}${path.sep}`));
    assert(targetFound, `golden target missing: ${surface.target}`);
    const payload = matching.sort((a, b) => a.source.localeCompare(b.source)).map((item) => `${item.source}\0${item.content}`).join('\0');
    assert.strictEqual(crypto.createHash('sha256').update(payload, 'utf8').digest('hex'), surface.sha256, `golden bytes drifted: ${surface.source_id}`);
  }

  // Markdown receives a safe origin marker; JSONC and CommonJS stay parseable/textual.
  const settings = first.artifacts.find((item) => item.source.endsWith('settings.jsonc'));
  const hook = first.artifacts.find((item) => item.source === 'scripts/forge-hook.js');
  assert(!settings.content.startsWith('<!--'));
  assert(!hook.content.startsWith('<!--'));
  assert.match(settings.content, /CLAUDE_PROJECT_DIR/);

  // Claude-only rendering does not resolve, read or create a Codex home.
  const codexHome = path.join(root, 'Codex Home Ω');
  const report = renderer.write({ repo: root, projectRoot: root, claudeHome: path.join(root, 'Claude Home Ω'), forgeHome: path.join(root, 'Forge Home Ω'), dryRun: true });
  assert.strictEqual(report.runtime, 'claude');
  assert(report.artifacts.every((item) => !item.destination.startsWith(codexHome)));
  assert.strictEqual(fs.existsSync(codexHome), false);

  // First write materializes managed Claude surfaces; second write is a no-op.
  const claudeHome = path.join(root, 'Claude Write Ω');
  const forgeHome = path.join(root, 'Forge Write Ω');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const options = { repo: root, projectRoot, claudeHome, forgeHome };
  const written = renderer.write(options);
  assert(written.written.length > 0);
  assert(fs.existsSync(path.join(claudeHome, 'agents', 'forge-executor.md')));
  assert(fs.existsSync(path.join(claudeHome, 'settings.json')));
  const repeat = renderer.write(options);
  assert.strictEqual(repeat.written.length, 0);
  assert(repeat.preserved.every((item) => item.reason === 'already-current'));

  // Backup paths remain safe when repository and user homes live on different
  // roots (a common Windows/macOS setup), and never escape backupDir.
  const externalProject = path.join(os.tmpdir(), `forge-external-project-${process.pid}`);
  const externalBackup = path.join(os.tmpdir(), `forge-external-backup-${process.pid}`);
  fs.mkdirSync(externalProject, { recursive: true });
  const externalOptions = { repo: root, projectRoot: externalProject, claudeHome: path.join(os.tmpdir(), `forge-external-claude-${process.pid}`), forgeHome: path.join(os.tmpdir(), `forge-external-forge-${process.pid}`) };
  renderer.write(externalOptions);
  fs.writeFileSync(path.join(externalProject, 'CLAUDE.md'), '<!-- forge-source:operator -->\nold\n');
  const externalUpdate = renderer.write({ ...externalOptions, backupDir: externalBackup });
  assert(externalUpdate.written.length > 0);
  assert(fs.readdirSync(externalBackup).length > 0);
  fs.rmSync(externalProject, { recursive: true, force: true });
  fs.rmSync(externalBackup, { recursive: true, force: true });

  // A user-owned settings file and project .gsd remain byte-identical.
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{\n  "operator": true\n}\n');
  const userOwned = renderer.write(options);
  assert(userOwned.conflicts.some((item) => item.destination.endsWith(path.join('Claude Write Ω', 'settings.json'))));
  assert.match(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'), /operator/);
  const gsd = path.join(projectRoot, '.gsd');
  fs.mkdirSync(gsd, { recursive: true });
  fs.writeFileSync(path.join(gsd, 'STATE.md'), 'user state\r\n');
  assert.strictEqual(fs.readFileSync(path.join(gsd, 'STATE.md'), 'utf8'), 'user state\r\n');

  // Unsafe custom destinations are rejected before writing.
  const unsafe = manifestFor(root);
  unsafe.sources[0].render_targets[0].path = '../outside';
  assert.throws(() => renderer.render({ repo: root, manifest: unsafe }), /destino|path inseguro/);
  console.log('forge-claude-renderer tests passed');
} finally {
  cleanup();
}
