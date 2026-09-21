#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const installer = require('./forge-installer.js');
const generation = require('./forge-generate.js');

const SCHEMA_VERSION = '1.0.0';
const COMPONENTS = Object.freeze(['core', 'adapter-claude', 'adapter-codex']);

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function slash(value) { return String(value).replace(/\\/g, '/'); }
function walk(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else if (entry.isFile()) output.push(full);
  }
  return output;
}
function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function stableEntries(entries) {
  return entries.map(({ component, path: file, bytes, sha256: digest }) => ({ component, path: file, bytes, sha256: digest }))
    .sort((left, right) => `${left.component}/${left.path}`.localeCompare(`${right.component}/${right.path}`, 'en'));
}
function packageChecksum(entries) { return sha256(Buffer.from(JSON.stringify(stableEntries(entries)), 'utf8')); }

function collectFile(component, logicalPath, source, entries, sources) {
  const bytes = fs.readFileSync(source);
  const normalized = slash(logicalPath);
  entries.push({ component, path: normalized, bytes: bytes.length, sha256: sha256(bytes) });
  // Retain immutable bytes: adapter projections live in a disposable render
  // root, and package materialization may happen after that root is removed.
  sources.set(`${component}/${normalized}`, { bytes });
}
function collectTree(component, logicalRoot, sourceRoot, entries, sources) {
  for (const file of walk(sourceRoot)) collectFile(component, path.join(logicalRoot, path.relative(sourceRoot, file)), file, entries, sources);
}

function build(options = {}) {
  const repo = path.resolve(options.repo || path.resolve(__dirname, '..'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-package-render Ω-'));
  const entries = [];
  const sources = new Map();
  try {
    for (const item of installer.MANAGED_CORE) {
      const source = path.join(repo, item);
      if (!fs.existsSync(source)) continue;
      if (fs.statSync(source).isDirectory()) {
        for (const file of walk(source)) {
          const relative = path.join(item, path.relative(source, file));
          if (installer.isRuntimeFile(relative)) collectFile('core', relative, file, entries, sources);
        }
      }
      else collectFile('core', item, source, entries, sources);
    }
    const version = Buffer.from(`${installer.VERSION}\n`, 'utf8');
    entries.push({ component: 'core', path: 'VERSION', bytes: version.length, sha256: sha256(version) });
    sources.set('core/VERSION', { bytes: version });

    const projectRoot = path.join(temp, 'project space Ω');
    const claudeHome = path.join(temp, 'Claude Home Ω');
    const codexHome = path.join(temp, 'Codex Home Ω');
    const forgeHome = path.join(temp, 'Forge Home Ω');
    fs.mkdirSync(projectRoot, { recursive: true });
    generation.generate({ repo, runtime: 'both', projectRoot, claudeHome, codexHome, forgeHome, platform: options.platform || process.platform });
    for (const [host, home] of [['claude', claudeHome], ['codex', codexHome]]) {
      const component = `adapter-${host}`;
      collectTree(component, 'home', home, entries, sources);
      const projectFile = path.join(projectRoot, host === 'claude' ? 'CLAUDE.md' : 'AGENTS.md');
      if (fs.existsSync(projectFile)) collectFile(component, path.join('project', path.basename(projectFile)), projectFile, entries, sources);
    }
    const normalized = stableEntries(entries);
    const componentSummary = Object.fromEntries(COMPONENTS.map((component) => {
      const selected = normalized.filter((entry) => entry.component === component);
      return [component, { files: selected.length, bytes: selected.reduce((sum, entry) => sum + entry.bytes, 0), sha256: packageChecksum(selected) }];
    }));
    const manifest = {
      schema_version: SCHEMA_VERSION,
      product_version: installer.VERSION,
      package_format: 'forge-directory-v1',
      components: componentSummary,
      files: normalized,
      package_sha256: packageChecksum(normalized),
    };
    return { manifest, sources };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function create(output, options = {}) {
  const target = path.resolve(output);
  if (fs.existsSync(target)) throw new Error(`output already exists: ${target}`);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`);
  const built = build(options);
  try {
    for (const entry of built.manifest.files) {
      const key = `${entry.component}/${entry.path}`;
      const source = built.sources.get(key);
      if (!source) throw new Error(`source missing for ${key}`);
      const destination = path.join(staging, 'payload', entry.component, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, source.bytes);
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(built.manifest, null, 2)}\n`, 'utf8');
    const checksums = built.manifest.files.map((entry) => `${entry.sha256}  payload/${entry.component}/${entry.path}`).join('\n');
    fs.writeFileSync(path.join(staging, 'CHECKSUMS.sha256'), `${checksums}\n`, 'utf8');
    fs.renameSync(staging, target);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return verify(target);
}

function verify(output) {
  const root = path.resolve(output);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== SCHEMA_VERSION || manifest.package_format !== 'forge-directory-v1') throw new Error('package manifest incompatible');
  const errors = [];
  for (const entry of manifest.files || []) {
    if (!COMPONENTS.includes(entry.component) || !entry.path || entry.path.includes('..')) { errors.push(`invalid-entry:${entry.component}/${entry.path}`); continue; }
    const file = path.join(root, 'payload', entry.component, ...entry.path.split('/'));
    if (!inside(path.join(root, 'payload'), file) || !fs.existsSync(file)) { errors.push(`missing:${entry.component}/${entry.path}`); continue; }
    const bytes = fs.readFileSync(file);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) errors.push(`checksum:${entry.component}/${entry.path}`);
  }
  if (packageChecksum(manifest.files || []) !== manifest.package_sha256) errors.push('package-checksum');
  const expectedChecksums = (manifest.files || []).map((entry) => `${entry.sha256}  payload/${entry.component}/${entry.path}`).join('\n') + '\n';
  if (fs.readFileSync(path.join(root, 'CHECKSUMS.sha256'), 'utf8') !== expectedChecksums) errors.push('checksums-file');
  return { ok: errors.length === 0, errors, manifest };
}

function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    let destination = null; let verifyPath = null; let repo = null; let json = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--output') destination = argv[++index];
      else if (argv[index] === '--verify') verifyPath = argv[++index];
      else if (argv[index] === '--repo') repo = argv[++index];
      else if (argv[index] === '--json') json = true;
      else if (argv[index] === '--help' || argv[index] === '-h') { output('Usage: forge-package.js (--output DIR | --verify DIR) [--repo DIR] [--json]\n'); return 0; }
      else throw new Error(`unknown option: ${argv[index]}`);
    }
    if (Boolean(destination) === Boolean(verifyPath)) throw new Error('choose exactly one of --output or --verify');
    const report = destination ? create(destination, { repo }) : verify(verifyPath);
    output(json ? `${JSON.stringify(report)}\n` : `${report.ok ? 'verified' : 'failed'} ${report.manifest.package_sha256}\n`);
    return report.ok ? 0 : 1;
  } catch (error) { errorOutput(`forge-package: ${error.message}\n`); return 1; }
}

if (require.main === module) process.exitCode = main();
module.exports = { SCHEMA_VERSION, COMPONENTS, build, create, main, packageChecksum, sha256, stableEntries, verify, walk };
