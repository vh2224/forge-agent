#!/usr/bin/env node
'use strict';

// Mandatory procedure composition; informational bundles and routing stay separate.
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { resolveForgePaths } = require('./forge-home.js');
const { sha256 } = require('./forge-delivery.js');

const MANIFEST_PATH = 'shared/forge-procedures.json';
const BYTE_POLICY = 'utf8-no-bom-lf-v1';
const MAX_FILE_BYTES = 512 * 1024;
const MAX_COMPOSITION_BYTES = 8 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]{0,95}$/;
const HASH = /^[a-f0-9]{64}$/;
const MODULE_PATH = /^shared\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('procedure-manifest-invalid');
}
function list(value, nonempty = false) {
  if (!Array.isArray(value) || value.length > 256 || nonempty && !value.length
    || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 512)) fail('procedure-manifest-invalid');
}
function safeRelative(value) {
  return typeof value === 'string' && value.length <= 512 && !/[\\:\x00-\x1f]/.test(value)
    && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Hash and emit the same canonical UTF-8 bytes: strip initial BOM, fold EOL only. */
function canonicalProcedureBytes(bytes) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('procedure-encoding-invalid'); }
  content = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!content.trim() || content.includes('\0')) fail('procedure-content-invalid');
  return Buffer.from(content, 'utf8');
}

/** Validate the entire closed manifest and graph before reading any module. */
function validateProcedureManifest(manifest) {
  object(manifest, ['schema_version', 'byte_policy', 'core', 'modules', 'phases']);
  if (manifest.schema_version !== 1 || manifest.byte_policy !== BYTE_POLICY || typeof manifest.core !== 'string' || !ID.test(manifest.core)
    || !Array.isArray(manifest.modules) || !manifest.modules.length || manifest.modules.length > 256
    || !Array.isArray(manifest.phases) || !manifest.phases.length || manifest.phases.length > 256) fail('procedure-manifest-invalid');
  const modules = new Map();
  const paths = new Set();
  for (const module of manifest.modules) {
    object(module, ['id', 'path', 'sha256', 'status', 'owner', 'dependencies', 'preconditions', 'postconditions', 'tests']);
    if (typeof module.id !== 'string' || !ID.test(module.id) || !safeRelative(module.path) || !MODULE_PATH.test(module.path)
      || typeof module.owner !== 'string' || !/^T\d{2}$/.test(module.owner)
      || !['ready', 'pending'].includes(module.status)
      || (module.status === 'ready' ? typeof module.sha256 !== 'string' || !HASH.test(module.sha256) : module.sha256 !== null)) fail('procedure-manifest-invalid');
    for (const key of ['dependencies', 'preconditions', 'postconditions', 'tests']) list(module[key], key !== 'dependencies');
    if (modules.has(module.id) || paths.has(module.path.toLowerCase())) fail('procedure-duplicate-module');
    modules.set(module.id, module); paths.add(module.path.toLowerCase());
  }
  const core = modules.get(manifest.core);
  if (!core || core.status !== 'ready' || core.dependencies.length) fail('procedure-core-invalid');
  const visited = new Set(); const visiting = new Set();
  function visit(id) {
    if (!modules.has(id)) fail('procedure-dependency-missing');
    if (visiting.has(id)) fail('procedure-dependency-cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of modules.get(id).dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of modules.keys()) visit(id);
  const phases = new Set();
  for (const phase of manifest.phases) {
    object(phase, ['id', 'modules', 'consumers', 'owner', 'preconditions', 'postconditions', 'tests']);
    if (typeof phase.id !== 'string' || !ID.test(phase.id) || phases.has(phase.id)
      || typeof phase.owner !== 'string' || !/^T\d{2}$/.test(phase.owner)) fail('procedure-phase-invalid');
    phases.add(phase.id);
    for (const key of ['modules', 'consumers', 'preconditions', 'postconditions', 'tests']) list(phase[key], true);
    for (const id of phase.modules) if (!modules.has(id)) fail('procedure-dependency-missing');
    for (const consumer of phase.consumers) if (!safeRelative(consumer)) fail('procedure-consumer-invalid');
  }
  return manifest;
}

// Paths come only from the canonical resolver's project/installation roots.
// lstat also distinguishes a dangling local manifest from genuine absence.
function resolveProcedureRoot(options = {}) {
  const paths = resolveForgePaths(options);
  for (const [scope, root] of [['project', paths.cwd], ['installed', paths.forgeHome]]) {
    try { fs.lstatSync(path.join(root, MANIFEST_PATH)); }
    catch (error) { if (error.code === 'ENOENT') continue; fail('procedure-manifest-unreadable'); }
    try { return { scope, root: fs.realpathSync(root) }; }
    catch { fail('procedure-root-invalid'); }
  }
  fail('procedure-manifest-missing');
}

function readProcedureFile(root, relative) {
  if (!safeRelative(relative)) fail('procedure-path-invalid');
  let target;
  try { target = fs.realpathSync(path.join(root, relative)); }
  catch { fail('procedure-file-unreadable'); }
  const inside = path.relative(root, target);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) fail('procedure-path-outside-root');
  let descriptor;
  try {
    // Reject directories/devices before opening; do not read an outside target.
    const before = fs.statSync(target);
    if (!before.isFile()) fail('procedure-file-type');
    if (before.size > MAX_FILE_BYTES) fail('procedure-file-too-large');
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) fail('procedure-file-changed');
    if (stat.size > MAX_FILE_BYTES) fail('procedure-file-too-large');
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0; let read;
    do { read = fs.readSync(descriptor, bytes, size, bytes.length - size, null); size += read; } while (read && size < bytes.length);
    if (size > MAX_FILE_BYTES) fail('procedure-file-too-large');
    return canonicalProcedureBytes(bytes.subarray(0, size));
  } catch (error) { if (error.code && error.code.startsWith('procedure-')) throw error; fail('procedure-file-unreadable'); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function loadManifest(options) {
  const resolved = resolveProcedureRoot(options);
  const bytes = readProcedureFile(resolved.root, MANIFEST_PATH);
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('procedure-manifest-invalid'); }
  validateProcedureManifest(manifest);
  return { ...resolved, manifest, manifest_sha256: sha256(bytes) };
}

/** Compose every mandatory dependency once. Optional budgets never enter this path. */
function loadProcedureContext(options = {}) {
  const loaded = loadManifest(options);
  const phase = loaded.manifest.phases.find(item => item.id === options.phase);
  if (!phase) fail('procedure-phase-unmapped');
  const modules = new Map(loaded.manifest.modules.map(item => [item.id, item]));
  const ordered = []; const seen = new Set();
  function include(id) {
    if (seen.has(id)) return;
    const module = modules.get(id);
    if (module.status !== 'ready') fail('procedure-module-pending');
    for (const dependency of module.dependencies) include(dependency);
    seen.add(id); ordered.push(module);
  }
  include(loaded.manifest.core);
  for (const id of phase.modules) include(id);
  const inserted = ordered.map(module => {
    const bytes = readProcedureFile(loaded.root, module.path);
    if (sha256(bytes) !== module.sha256) fail('procedure-integrity-mismatch');
    return { id: module.id, path: module.path, sha256: module.sha256, bytes: bytes.length, content: bytes.toString('utf8') };
  });
  const content = inserted.map(module => `<!-- forge-procedure:${module.id} -->\n${module.content}`).join('\n\n');
  if (Buffer.byteLength(content) > MAX_COMPOSITION_BYTES) fail('procedure-composition-too-large');
  return { schema_version: 1, phase: phase.id, scope: loaded.scope, root: loaded.root,
    byte_policy: BYTE_POLICY, manifest_sha256: loaded.manifest_sha256,
    modules: inserted.map(({ content: ignored, ...metadata }) => metadata),
    content, composition_sha256: sha256(Buffer.from(content, 'utf8')), bytes: Buffer.byteLength(content) };
}

module.exports = { MANIFEST_PATH, BYTE_POLICY, MAX_FILE_BYTES, canonicalProcedureBytes,
  validateProcedureManifest, resolveProcedureRoot, loadProcedureContext };

if (require.main === module) {
  try {
    const args = process.argv.slice(2); const options = {}; let validate = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--validate' && !validate) { validate = true; continue; }
      const key = { '--cwd': 'cwd', '--forge-home': 'forgeHome', '--phase': 'phase' }[args[i]];
      if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('procedure-cli-invalid');
      options[key] = args[++i];
    }
    if (validate && options.phase || !validate && !options.phase) fail('procedure-cli-invalid');
    const result = validate ? loadManifest(options) : loadProcedureContext(options);
    process.stdout.write(`${JSON.stringify(validate ? { valid: true, scope: result.scope,
      root: result.root, manifest_sha256: result.manifest_sha256, phases: result.manifest.phases.map(item => item.id) } : result)}\n`);
  } catch (error) { process.stderr.write(`${JSON.stringify({ error: error.code || 'procedure-load-failed' })}\n`); process.exitCode = 1; }
}
