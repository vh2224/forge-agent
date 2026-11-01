#!/usr/bin/env node
'use strict';

// Deterministic VSIX for the read-only VS Code panel. The bytes depend only on
// the allowlisted extension files and the product VERSION: no timestamps, no
// compression (zlib output varies between Node/zlib releases), no host paths.
// Only Node built-ins are used; nothing here touches the network or npm.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EXTENSION_ROOT = 'extensions/forge-vscode';
const PANEL_FILES = Object.freeze([
  'package.json', 'extension.js', 'forge-panel-model.js', 'forge-panel-reader.js', 'media/forge.svg', 'README.md',
]);
const EXTENSION_ID = 'forge-agent.forge-vscode';
const EXTENSION_NAME = 'forge-vscode';
const EXTENSION_PUBLISHER = 'forge-agent';
const EXTENSION_MAIN = './extension.js';
const LIMITS = Object.freeze({ file: 1024 * 1024, total: 8 * 1024 * 1024, entries: 16 });
const DESCRIPTORS = Object.freeze(['[Content_Types].xml', 'extension.vsixmanifest']);
const CONTENT_TYPES = Object.freeze([
  ['.js', 'application/javascript'], ['.json', 'application/json'], ['.md', 'text/markdown'],
  ['.svg', 'image/svg+xml'], ['.vsixmanifest', 'text/xml'], ['.xml', 'text/xml'],
]);
const BUILD_REASONS = Object.freeze(['tree-missing', 'file-missing', 'link', 'not-regular-file', 'size', 'crlf', 'name',
  'identity', 'engine-range', 'version-invalid']);
const VERIFY_REASONS = Object.freeze(['malformed', 'trailing-bytes', 'method', 'crc-mismatch', 'size-mismatch',
  'entry-extra', 'entry-missing', 'entry-order', 'identity', 'version-mismatch', 'sha256-mismatch']);
// 1980-01-01 00:00:00, the first representable DOS timestamp.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const ZIP_VERSION = 20;

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function invalid(reason, detail) {
  return Object.assign(new Error(`package-invalid: ${reason}${detail ? ` (${detail})` : ''}`), { code: 'package-invalid', reason });
}

// Own table: zlib.crc32 only exists from Node 20.15/22.2 and Forge supports 18.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function fileName(version) { return `forge-vscode-${version}.vsix`; }

function validVersion(version) { return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version); }

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Same physical rule as forge-panel-reader: every component below the
// canonical repo root is a real directory or regular file resolving to itself.
function readPhysical(root, relative) {
  const parts = relative.split('/');
  if (parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..')) throw invalid('name', relative);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (_) { throw invalid(index === parts.length - 1 ? 'file-missing' : 'tree-missing', relative); }
    if (stat.isSymbolicLink()) throw invalid('link', relative);
    let real;
    try { real = fs.realpathSync.native(current); } catch (_) { throw invalid('link', relative); }
    if (!samePath(real, current)) throw invalid('link', relative);
    if (index < parts.length - 1 && !stat.isDirectory()) throw invalid('not-regular-file', relative);
    if (index === parts.length - 1 && !stat.isFile()) throw invalid('not-regular-file', relative);
    if (index === parts.length - 1 && stat.size > LIMITS.file) throw invalid('size', relative);
  }
  const bytes = fs.readFileSync(current);
  if (bytes.length > LIMITS.file) throw invalid('size', relative);
  if (bytes.includes(0x0d)) throw invalid('crlf', relative);
  return bytes;
}

function extensionRoot(repo) {
  let root;
  try { root = fs.realpathSync.native(path.resolve(repo)); } catch (_) { throw invalid('tree-missing'); }
  let current = root;
  for (const part of EXTENSION_ROOT.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (_) { throw invalid('tree-missing'); }
    if (stat.isSymbolicLink()) throw invalid('link', EXTENSION_ROOT);
    if (!stat.isDirectory()) throw invalid('tree-missing');
    let real;
    try { real = fs.realpathSync.native(current); } catch (_) { throw invalid('link', EXTENSION_ROOT); }
    if (!samePath(real, current)) throw invalid('link', EXTENSION_ROOT);
  }
  return current;
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function vsixManifest(pkg) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />`,
    `    <DisplayName>${xml(pkg.displayName || pkg.name)}</DisplayName>`,
    `    <Description xml:space="preserve">${xml(pkg.description || '')}</Description>`,
    '    <Tags></Tags>',
    '    <Categories>Other</Categories>',
    '    <GalleryFlags>Public</GalleryFlags>',
    '    <Properties>',
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />`,
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />',
    `      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xml([].concat(pkg.extensionKind || ['workspace']).join(','))}" />`,
    '      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />',
    '      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />',
    '    </Properties>',
    '  </Metadata>',
    '  <Installation>',
    '    <InstallationTarget Id="Microsoft.VisualStudio.Code" />',
    '  </Installation>',
    '  <Dependencies />',
    '  <Assets>',
    '    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />',
    '    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />',
    '  </Assets>',
    '</PackageManifest>',
    '',
  ].join('\n');
}

function contentTypes() {
  const defaults = CONTENT_TYPES.map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}" />`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}</Types>\n`;
}

function expectedNames() {
  return DESCRIPTORS.concat(PANEL_FILES.map(file => `extension/${file}`).sort());
}

function header(fields) {
  const buffer = Buffer.alloc(fields.reduce((sum, [size]) => sum + size, 0));
  let offset = 0;
  for (const [size, value] of fields) {
    if (size === 2) buffer.writeUInt16LE(value, offset);
    else buffer.writeUInt32LE(value >>> 0, offset);
    offset += size;
  }
  return buffer;
}

// Stored-only zip: local headers, central directory and EOCD, no zip64,
// extra fields, comments, flags or external attributes.
function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    const local = header([[4, 0x04034b50], [2, ZIP_VERSION], [2, 0], [2, 0], [2, DOS_TIME], [2, DOS_DATE],
      [4, crc], [4, bytes.length], [4, bytes.length], [2, nameBytes.length], [2, 0]]);
    locals.push(local, nameBytes, bytes);
    central.push(header([[4, 0x02014b50], [2, ZIP_VERSION], [2, ZIP_VERSION], [2, 0], [2, 0], [2, DOS_TIME], [2, DOS_DATE],
      [4, crc], [4, bytes.length], [4, bytes.length], [2, nameBytes.length], [2, 0], [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]), nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = header([[4, 0x06054b50], [2, 0], [2, 0], [2, entries.length], [2, entries.length], [4, directory.length], [4, offset], [2, 0]]);
  return Buffer.concat([...locals, directory, end]);
}

function buildVsix(options = {}) {
  const version = options.version;
  if (!validVersion(version)) throw invalid('version-invalid', JSON.stringify(version));
  const root = extensionRoot(options.repo || path.resolve(__dirname, '..'));
  const files = new Map();
  let total = 0;
  for (const relative of PANEL_FILES) {
    const bytes = readPhysical(root, relative);
    total += bytes.length;
    if (total > LIMITS.total) throw invalid('size', 'total');
    files.set(relative, bytes);
  }
  let pkg;
  try { pkg = JSON.parse(files.get('package.json').toString('utf8')); } catch (_) { throw invalid('identity', 'package.json'); }
  if (!pkg || pkg.name !== EXTENSION_NAME || pkg.publisher !== EXTENSION_PUBLISHER || pkg.main !== EXTENSION_MAIN) throw invalid('identity');
  const engine = pkg.engines && pkg.engines.vscode;
  const range = typeof engine === 'string' ? /^\^(\d+\.\d+\.\d+)$/.exec(engine) : null;
  if (!range) throw invalid('engine-range', JSON.stringify(engine));
  // Only the version changes: the source package stays 0.1.0, the installed
  // package follows the product release so every release is a new version.
  const embedded = { ...pkg, version };
  files.set('package.json', Buffer.from(`${JSON.stringify(embedded, null, 2)}\n`, 'utf8'));
  const entries = [
    { name: DESCRIPTORS[0], bytes: Buffer.from(contentTypes(), 'utf8') },
    { name: DESCRIPTORS[1], bytes: Buffer.from(vsixManifest(embedded), 'utf8') },
    ...PANEL_FILES.map(file => `extension/${file}`).sort().map(name => ({ name, bytes: files.get(name.slice('extension/'.length)) })),
  ];
  if (entries.length > LIMITS.entries) throw invalid('size', 'entries');
  const bytes = writeZip(entries);
  return {
    bytes, sha256: sha256(bytes), version, extension_id: EXTENSION_ID, engine_minimum: range[1],
    file_name: fileName(version), entries: entries.map(entry => ({ name: entry.name, bytes: entry.bytes.length, sha256: sha256(entry.bytes) })),
  };
}

function broken(reason) { return Object.assign(new Error(`vsix-invalid: ${reason}`), { code: 'vsix-invalid', reason }); }

function safeEntryName(name) {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..');
}

// Strict reader for exactly the structure writeZip produces.
function extractEntries(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (bytes.length < 22) throw broken('malformed');
  const endAt = bytes.length - 22;
  if (bytes.readUInt32LE(endAt) !== 0x06054b50) {
    for (let at = endAt - 1; at >= 0; at--) if (bytes.readUInt32LE(at) === 0x06054b50) throw broken('trailing-bytes');
    throw broken('malformed');
  }
  const count = bytes.readUInt16LE(endAt + 10);
  const directorySize = bytes.readUInt32LE(endAt + 12);
  const directoryAt = bytes.readUInt32LE(endAt + 16);
  if (bytes.readUInt16LE(endAt + 4) !== 0 || bytes.readUInt16LE(endAt + 6) !== 0 || bytes.readUInt16LE(endAt + 8) !== count
    || bytes.readUInt16LE(endAt + 20) !== 0 || count > LIMITS.entries || directoryAt + directorySize !== endAt) throw broken('malformed');
  const entries = [];
  let cursor = directoryAt;
  let expectedLocal = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > endAt || bytes.readUInt32LE(cursor) !== 0x02014b50) throw broken('malformed');
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32);
    const localAt = bytes.readUInt32LE(cursor + 42);
    if (method !== 0) throw broken('method');
    if (bytes.readUInt16LE(cursor + 8) !== 0 || extra || comment || bytes.readUInt32LE(cursor + 38) !== 0) throw broken('malformed');
    if (compressed !== size) throw broken('size-mismatch');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!safeEntryName(name) || size > LIMITS.file) throw broken('malformed');
    cursor += 46 + nameLength;
    if (localAt !== expectedLocal || localAt + 30 > directoryAt || bytes.readUInt32LE(localAt) !== 0x04034b50) throw broken('malformed');
    if (bytes.readUInt16LE(localAt + 8) !== 0) throw broken('method');
    const localName = bytes.readUInt16LE(localAt + 26);
    if (bytes.readUInt16LE(localAt + 6) !== 0 || bytes.readUInt16LE(localAt + 28) !== 0 || localName !== nameLength
      || bytes.subarray(localAt + 30, localAt + 30 + localName).toString('utf8') !== name) throw broken('malformed');
    if (bytes.readUInt32LE(localAt + 14) !== crc) throw broken('crc-mismatch');
    if (bytes.readUInt32LE(localAt + 18) !== size || bytes.readUInt32LE(localAt + 22) !== size) throw broken('size-mismatch');
    const dataAt = localAt + 30 + localName;
    if (dataAt + size > directoryAt) throw broken('size-mismatch');
    const data = bytes.subarray(dataAt, dataAt + size);
    if (crc32(data) !== crc) throw broken('crc-mismatch');
    entries.push({ name, bytes: Buffer.from(data) });
    expectedLocal = dataAt + size;
  }
  if (cursor !== endAt || expectedLocal !== directoryAt) throw broken('malformed');
  return entries;
}

function verifyVsix(input, expected = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const fail = (reason, entries = null) => ({ ok: false, reason, entries });
  let entries;
  try { entries = extractEntries(bytes); } catch (error) { return fail(VERIFY_REASONS.includes(error.reason) ? error.reason : 'malformed'); }
  const names = entries.map(entry => entry.name);
  const wanted = expectedNames();
  if (names.some(name => !wanted.includes(name)) || new Set(names).size !== names.length) return fail('entry-extra');
  if (wanted.some(name => !names.includes(name))) return fail('entry-missing');
  if (names.some((name, index) => name !== wanted[index])) return fail('entry-order');
  let pkg;
  try { pkg = JSON.parse(entries.find(entry => entry.name === 'extension/package.json').bytes.toString('utf8')); } catch (_) { return fail('identity'); }
  if (!pkg || `${pkg.publisher}.${pkg.name}` !== EXTENSION_ID || pkg.main !== EXTENSION_MAIN) return fail('identity');
  const manifest = entries.find(entry => entry.name === 'extension.vsixmanifest').bytes.toString('utf8');
  const identity = /<Identity Language="en-US" Id="([^"]*)" Version="([^"]*)" Publisher="([^"]*)" \/>/.exec(manifest);
  if (!identity || identity[1] !== EXTENSION_NAME || identity[3] !== EXTENSION_PUBLISHER) return fail('identity');
  if (identity[2] !== pkg.version || (expected.version !== undefined && pkg.version !== expected.version)) return fail('version-mismatch');
  if (expected.sha256 !== undefined && sha256(bytes) !== expected.sha256) return fail('sha256-mismatch');
  return { ok: true, reason: null, entries };
}

function writeOutput(file, bytes) {
  const fd = fs.openSync(path.resolve(file), 'wx', 0o600);
  try { fs.writeSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
}

function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    let repo = path.resolve(__dirname, '..'); let destination = null; let json = false;
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--repo') repo = path.resolve(argv[++index] || '');
      else if (argv[index] === '--output') destination = argv[++index] || '';
      else if (argv[index] === '--json') json = true;
      else if (argv[index] === '--help' || argv[index] === '-h') { output('Usage: forge-vscode-package.js [--repo DIR] [--output FILE] [--json]\n'); return 0; }
      else throw new Error(`opção desconhecida: ${argv[index]}`);
    }
    if (destination === '') throw new Error('--output exige um arquivo');
    const { VERSION } = require('./forge-version.js');
    const built = buildVsix({ repo, version: VERSION });
    // Manual verification in a clean profile only; never overwrites a file.
    if (destination) writeOutput(destination, built.bytes);
    const report = { file_name: built.file_name, version: built.version, sha256: built.sha256 };
    output(json ? `${JSON.stringify(report)}\n` : `${report.file_name} ${report.sha256}\n`);
    return 0;
  } catch (error) {
    errorOutput(`forge-vscode-package: ${error.code === 'package-invalid' ? `package-invalid ${error.reason}` : error.message}\n`);
    return 1;
  }
}

module.exports = {
  EXTENSION_ROOT, PANEL_FILES, EXTENSION_ID, LIMITS, DESCRIPTORS, BUILD_REASONS, VERIFY_REASONS,
  crc32, fileName, expectedNames, buildVsix, verifyVsix, extractEntries, readPhysical, writeZip, main,
};
if (require.main === module) process.exitCode = main();
