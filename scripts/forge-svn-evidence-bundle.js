#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCHEMA = 'forge-svn-local-evidence/v1';
const PROFILE = 'svn-local-readonly/v1';
const SANITIZED_CWD = '<PROTECTED_WORKING_COPY>';
const COMMANDS = Object.freeze([
  ['svn', ['info', '--xml', '.']],
  ['svn', ['status', '.']],
  ['svn', ['diff', '.']],
  ['svn', ['proplist', '--xml', '--recursive', '.']],
  ['svn', ['propget', 'svn:ignore', '.']],
  ['svnversion', ['.']]
]);
const ENCODINGS = new Set(['utf8', 'binary']);

function fail(code, detail = '') { throw new Error(`${code}${detail ? `: ${detail}` : ''}`); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function seal(manifest) {
  const copy = JSON.parse(JSON.stringify(manifest)); delete copy.seal;
  return sha256(Buffer.from(canonical(copy), 'utf8'));
}
function posix(relative) { return relative.split(path.sep).join('/'); }
function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 && relative === posix(relative) &&
    !path.posix.isAbsolute(relative) && !relative.split('/').includes('..');
}
function encodingOf(bytes) {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? 'utf8' : 'binary';
}
function descriptor(bytes) { return { bytes: bytes.length, sha256: sha256(bytes), encoding: encodingOf(bytes) }; }
function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function commandAllowed(file, argv) {
  return COMMANDS.some(([allowedFile, allowedArgv]) => file === allowedFile &&
    argv.length === allowedArgv.length && argv.every((v, i) => v === allowedArgv[i]));
}
function assertCommand(file, argv) {
  if (!commandAllowed(file, argv)) fail('argv_not_allowed', `${file} ${argv.join(' ')}`);
  if (argv.some(v => /^(?:[a-z]+:\/\/|\\\\)/i.test(v))) fail('url_not_allowed');
}
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); }
function listFiles(root) {
  const found = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) found.push(posix(path.relative(root, absolute)));
      else fail('unsupported_file_type', posix(path.relative(root, absolute)));
    }
  }
  visit(root); return found.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}
function inventory(root, files) {
  return files.map(relative => {
    if (!safeRelative(relative)) fail('invalid_inventory_path', relative);
    const bytes = fs.readFileSync(path.join(root, ...relative.split('/')));
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
}
function defaultRunner(file, argv, options) {
  return spawnSync(file, argv, { cwd: options.cwd, encoding: null, shell: false, windowsHide: true });
}

function capture(options) {
  const cwd = path.resolve(options.cwd);
  const output = path.resolve(options.output);
  if (!fs.statSync(cwd).isDirectory()) fail('cwd_not_directory');
  if (isInside(cwd, output)) fail('output_must_be_outside_target');
  if (fs.existsSync(output)) fail('output_must_not_exist');
  fs.mkdirSync(output, { recursive: false });
  const runner = options.runner || defaultRunner;
  const commands = [];
  for (let index = 0; index < COMMANDS.length; index++) {
    const [file, argv] = COMMANDS[index]; assertCommand(file, argv);
    const result = runner(file, [...argv], { cwd });
    const stdout = Buffer.from(result.stdout || []), stderr = Buffer.from(result.stderr || []);
    const dir = path.join(output, 'commands', String(index).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'stdout.bin'), stdout, { flag: 'wx' });
    fs.writeFileSync(path.join(dir, 'stderr.bin'), stderr, { flag: 'wx' });
    const item = { executable: file, argv: [...argv], exit: result.status,
      signal: result.signal || null, error: result.error ? String(result.error.message || result.error) : null,
      stdout: descriptor(stdout), stderr: descriptor(stderr) };
    writeJson(path.join(dir, 'invocation.json'), item); commands.push(item);
  }
  const files = listFiles(output);
  const manifest = { schema: SCHEMA, profile: PROFILE, mode: 'raw',
    captured_at: (options.now || (() => new Date().toISOString()))(), cwd,
    platform: options.platform || process.platform, hash: 'sha256', commands,
    inventory: inventory(output, files), derivation: null };
  manifest.seal = seal(manifest); writeJson(path.join(output, 'manifest.json'), manifest);
  return manifest;
}

function readManifest(root) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); }
  catch (error) { fail('manifest_unreadable', error.message); }
  return manifest;
}
function validateShape(m) {
  if (m.schema !== SCHEMA) fail('unknown_schema');
  if (m.profile !== PROFILE) fail('unknown_profile');
  if (!['raw', 'sanitized'].includes(m.mode)) fail('invalid_mode');
  if (m.mode === 'raw' ? !path.isAbsolute(m.cwd) : m.cwd !== SANITIZED_CWD) fail('invalid_cwd');
  if (!Array.isArray(m.commands) || m.commands.length !== COMMANDS.length) fail('invalid_commands');
  m.commands.forEach((c, i) => {
    assertCommand(c.executable, c.argv);
    for (const stream of ['stdout', 'stderr']) {
      if (!c[stream] || !Number.isSafeInteger(c[stream].bytes) || !/^[a-f0-9]{64}$/.test(c[stream].sha256) || !ENCODINGS.has(c[stream].encoding)) fail('invalid_stream_metadata', `${i}/${stream}`);
    }
  });
  if (!Array.isArray(m.inventory) || !m.inventory.every(x => safeRelative(x.path))) fail('invalid_inventory');
  const paths = m.inventory.map(x => x.path);
  if (paths.join('\0') !== [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join('\0') || new Set(paths).size !== paths.length) fail('inventory_not_canonical');
}

function verify(root) {
  root = path.resolve(root); const m = readManifest(root); validateShape(m);
  const actual = listFiles(root).filter(x => x !== 'manifest.json');
  const expected = m.inventory.map(x => x.path);
  if (actual.join('\0') !== expected.join('\0')) fail('inventory_mismatch');
  for (const entry of m.inventory) {
    const bytes = fs.readFileSync(path.join(root, ...entry.path.split('/')));
    if (bytes.length !== entry.bytes) fail('length_mismatch', entry.path);
    if (sha256(bytes) !== entry.sha256) fail('hash_mismatch', entry.path);
  }
  m.commands.forEach((c, i) => {
    const dir = path.join(root, 'commands', String(i).padStart(2, '0'));
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'invocation.json'), 'utf8'));
    if (canonical(stored) !== canonical(c)) fail('command_metadata_mismatch', String(i));
    for (const stream of ['stdout', 'stderr']) {
      const bytes = fs.readFileSync(path.join(dir, `${stream}.bin`));
      if (bytes.length !== c[stream].bytes) fail('length_mismatch', `${i}/${stream}`);
      if (sha256(bytes) !== c[stream].sha256) fail('hash_mismatch', `${i}/${stream}`);
      if (encodingOf(bytes) !== c[stream].encoding) fail('encoding_mismatch', `${i}/${stream}`);
    }
  });
  if (seal(m) !== m.seal) fail('seal_mismatch'); return m;
}

function sanitize(options) {
  const source = path.resolve(options.input), output = path.resolve(options.output);
  const raw = verify(source); if (raw.mode !== 'raw') fail('sanitize_requires_raw');
  if (fs.existsSync(output)) fail('output_must_not_exist');
  fs.cpSync(source, output, { recursive: true, errorOnExist: true, force: false });
  const manifestPath = path.join(output, 'manifest.json'); fs.unlinkSync(manifestPath);
  const safe = JSON.parse(JSON.stringify(raw)); safe.mode = 'sanitized'; safe.cwd = SANITIZED_CWD;
  const sensitive = Buffer.from([87, 68, 77, 65]).toString('utf8');
  safe.commands.forEach((command, index) => {
    const dir = path.join(output, 'commands', String(index).padStart(2, '0'));
    for (const stream of ['stdout', 'stderr']) {
      const file = path.join(dir, `${stream}.bin`);
      let bytes = fs.readFileSync(file);
      if (encodingOf(bytes) === 'utf8') {
        const text = bytes.toString('utf8').split(raw.cwd).join(SANITIZED_CWD)
          .replace(new RegExp(sensitive, 'gi'), 'PROTECTED_WC');
        bytes = Buffer.from(text, 'utf8'); fs.writeFileSync(file, bytes);
      }
      command[stream] = descriptor(bytes);
    }
    fs.writeFileSync(path.join(dir, 'invocation.json'), `${JSON.stringify(command, null, 2)}\n`);
  });
  safe.derivation = { source_manifest_sha256: raw.seal, byte_equivalent: false,
    note: 'text streams sanitized; historical absent bytes are not reconstructed' };
  safe.inventory = inventory(output, listFiles(output));
  safe.seal = seal(safe); writeJson(manifestPath, safe); verify(output); return safe;
}

function main(argv) {
  const [mode, ...args] = argv;
  const get = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  if (mode === 'capture') return capture({ cwd: get('--cwd'), output: get('--output') });
  if (mode === 'sanitize') return sanitize({ input: get('--input'), output: get('--output') });
  if (mode === 'verify') return verify(get('--input'));
  fail('usage', 'capture --cwd X --output Y | sanitize --input X --output Y | verify --input X');
}
if (require.main === module) {
  try { const result = main(process.argv.slice(2)); process.stdout.write(`${JSON.stringify({ ok: true, mode: result.mode })}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { SCHEMA, PROFILE, SANITIZED_CWD, COMMANDS, canonical, seal, commandAllowed, capture, sanitize, verify, main };
