#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vsix = require('./forge-vscode-package.js');

const REPO = path.resolve(__dirname, '..');
const SOURCE = path.join(REPO, 'extensions', 'forge-vscode');
const SCRIPT = path.join(__dirname, 'forge-vscode-package.js');
const VERSION = '7.8.9';
const SENTINEL = 'forge-personal-sentinel-7f3a';
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-vscode-package Ω-'));
let passed = 0;
let skipped = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
function skip(name, reason) { skipped++; process.stdout.write(`  - SKIP ${name}: ${reason}\n`); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
let cases = 0;
// Minimal repo copy: only the allowlisted extension tree plus its excluded test dir.
function minimalRepo(label = 'repo') {
  const repo = path.join(root, `${label} ${++cases}`);
  for (const relative of vsix.PANEL_FILES.concat(['test/mount-probe.js'])) {
    const destination = path.join(repo, 'extensions', 'forge-vscode', ...relative.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(SOURCE, ...relative.split('/')), destination);
  }
  return repo;
}
function refusal(fn) {
  try { fn(); } catch (error) { assert.strictEqual(error.code, 'package-invalid', error.message); return error.reason; }
  assert.fail('expected package-invalid');
}
function centralRecords(bytes) {
  const end = bytes.length - 22;
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const records = [];
  for (let index = 0; index < count; index++) {
    const nameLength = bytes.readUInt16LE(cursor + 28);
    records.push({
      at: cursor, madeBy: bytes.readUInt16LE(cursor + 4), needed: bytes.readUInt16LE(cursor + 6), flags: bytes.readUInt16LE(cursor + 8),
      method: bytes.readUInt16LE(cursor + 10), time: bytes.readUInt16LE(cursor + 12), date: bytes.readUInt16LE(cursor + 14),
      extra: bytes.readUInt16LE(cursor + 30), comment: bytes.readUInt16LE(cursor + 32), external: bytes.readUInt32LE(cursor + 38),
      local: bytes.readUInt32LE(cursor + 42), name: bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
    });
    cursor += 46 + nameLength;
  }
  return { records, commentLength: bytes.readUInt16LE(end + 20) };
}
function python() {
  for (const command of ['python3', 'python']) {
    const probe = spawnSync(command, ['-c', 'import sys,zipfile; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 15000 });
    if (!probe.error && probe.status === 0 && probe.stdout.trim() === '3') return command;
  }
  return null;
}

try {
  test('crc32 is the standard polynomial: "123456789" = cbf43926', () => {
    assert.strictEqual(vsix.crc32(Buffer.from('123456789', 'ascii')).toString(16), 'cbf43926');
    assert.strictEqual(vsix.crc32(Buffer.alloc(0)), 0);
  });

  const built = vsix.buildVsix({ repo: REPO, version: VERSION });

  test('two builds and a minimal repo copy produce identical bytes and sha256', () => {
    const again = vsix.buildVsix({ repo: REPO, version: VERSION });
    assert.deepStrictEqual(again.bytes, built.bytes);
    assert.strictEqual(again.sha256, built.sha256);
    assert.strictEqual(built.sha256, sha256(built.bytes));
    const copy = vsix.buildVsix({ repo: minimalRepo(), version: VERSION });
    assert.deepStrictEqual(copy.bytes, built.bytes);
    assert.strictEqual(built.file_name, `forge-vscode-${VERSION}.vsix`);
    assert.strictEqual(vsix.fileName(VERSION), built.file_name);
    assert.strictEqual(built.extension_id, 'forge-agent.forge-vscode');
    assert.strictEqual(built.engine_minimum, '1.90.0');
    assert.notStrictEqual(vsix.buildVsix({ repo: REPO, version: '7.8.10' }).sha256, built.sha256, 'the version is part of the identity');
  });

  test('stored zip: fixed DOS date, flags 0, made-by 20, no extra/comment/attributes, fixed order', () => {
    const { records, commentLength } = centralRecords(built.bytes);
    assert.strictEqual(commentLength, 0);
    assert.deepStrictEqual(records.map(entry => entry.name), [
      '[Content_Types].xml', 'extension.vsixmanifest', 'extension/README.md', 'extension/extension.js',
      'extension/forge-panel-model.js', 'extension/forge-panel-reader.js', 'extension/media/forge.svg', 'extension/package.json',
    ]);
    assert.deepStrictEqual(records.map(entry => entry.name).slice(2), records.map(entry => entry.name).slice(2).sort());
    for (const entry of records) {
      assert.deepStrictEqual([entry.method, entry.flags, entry.madeBy, entry.needed, entry.extra, entry.comment, entry.external, entry.time, entry.date],
        [0, 0, 20, 20, 0, 0, 0, 0, 0x21], entry.name);
      assert.strictEqual(built.bytes.readUInt32LE(entry.local), 0x04034b50);
      assert.strictEqual(built.bytes.readUInt16LE(entry.local + 28), 0, 'local extra field');
    }
    assert.deepStrictEqual(vsix.extractEntries(built.bytes).map(entry => entry.name), vsix.expectedNames());
  });

  test('content: exactly the six allowlisted files plus descriptors; test/ never enters', () => {
    const entries = vsix.extractEntries(built.bytes);
    const byName = new Map(entries.map(entry => [entry.name, entry.bytes]));
    assert.strictEqual(entries.length, 8);
    assert(!entries.some(entry => /(^|\/)test\//.test(entry.name) || entry.name.endsWith('.vsix')));
    for (const file of vsix.PANEL_FILES.filter(file => file !== 'package.json')) {
      assert.deepStrictEqual(byName.get(`extension/${file}`), fs.readFileSync(path.join(SOURCE, ...file.split('/'))), file);
    }
    const source = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8'));
    assert.strictEqual(source.version, '0.1.0', 'the source package keeps its own version');
    assert.strictEqual(byName.get('extension/package.json').toString('utf8'), `${JSON.stringify({ ...source, version: VERSION }, null, 2)}\n`);
  });

  test('vsixmanifest identity, engine, extension kind, assets and content types', () => {
    const byName = new Map(vsix.extractEntries(built.bytes).map(entry => [entry.name, entry.bytes.toString('utf8')]));
    const manifest = byName.get('extension.vsixmanifest');
    assert.match(manifest, /<PackageManifest Version="2\.0\.0"/);
    assert.match(manifest, new RegExp(`<Identity Language="en-US" Id="forge-vscode" Version="${VERSION.replace(/\./g, '\\.')}" Publisher="forge-agent" />`));
    assert.match(manifest, /<Property Id="Microsoft\.VisualStudio\.Code\.Engine" Value="\^1\.90\.0" \/>/);
    assert.match(manifest, /<Property Id="Microsoft\.VisualStudio\.Code\.ExtensionKind" Value="workspace" \/>/);
    assert.match(manifest, /<InstallationTarget Id="Microsoft\.VisualStudio\.Code" \/>/);
    assert.match(manifest, /<Asset Type="Microsoft\.VisualStudio\.Code\.Manifest" Path="extension\/package\.json" Addressable="true" \/>/);
    assert.match(manifest, /<Asset Type="Microsoft\.VisualStudio\.Services\.Content\.Details" Path="extension\/README\.md" Addressable="true" \/>/);
    const types = byName.get('[Content_Types].xml');
    for (const extension of ['.json', '.js', '.md', '.svg', '.vsixmanifest', '.xml']) {
      assert.match(types, new RegExp(`<Default Extension="${extension.replace('.', '\\.')}" ContentType="[^"]+" />`), extension);
    }
  });

  test('bytes carry no repo root, temp dir, HOME or planted personal sentinel', () => {
    const repo = minimalRepo('personal context');
    const home = path.join(root, 'operator home');
    for (const file of [path.join(home, '.forge-personal', 'context.json'), path.join(repo, '.gsd', 'forge', 'questions', 'q.json'),
      path.join(repo, 'extensions', 'forge-vscode', 'test', 'secret.txt'), path.join(repo, 'extensions', 'forge-vscode', 'local.vsix')]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${SENTINEL} ${home}\n`);
    }
    const planted = vsix.buildVsix({ repo, version: VERSION });
    assert.deepStrictEqual(planted.bytes, built.bytes, 'files outside the allowlist changed the package');
    const text = planted.bytes.toString('latin1');
    for (const needle of [SENTINEL, REPO, repo, root, os.tmpdir(), os.homedir(), home, REPO.replace(/\\/g, '/'), root.replace(/\\/g, '/')]) {
      assert.strictEqual(text.includes(needle), false, `package contains ${needle}`);
    }
  });

  test('build refusals carry a closed reason', () => {
    const missingTree = path.join(root, 'no extension tree');
    fs.mkdirSync(missingTree);
    assert.strictEqual(refusal(() => vsix.buildVsix({ repo: missingTree, version: VERSION })), 'tree-missing');
    const missingFile = minimalRepo();
    fs.unlinkSync(path.join(missingFile, 'extensions', 'forge-vscode', 'media', 'forge.svg'));
    assert.strictEqual(refusal(() => vsix.buildVsix({ repo: missingFile, version: VERSION })), 'file-missing');
    const directory = minimalRepo();
    fs.unlinkSync(path.join(directory, 'extensions', 'forge-vscode', 'README.md'));
    fs.mkdirSync(path.join(directory, 'extensions', 'forge-vscode', 'README.md'));
    assert.strictEqual(refusal(() => vsix.buildVsix({ repo: directory, version: VERSION })), 'not-regular-file');
    const crlf = minimalRepo();
    fs.writeFileSync(path.join(crlf, 'extensions', 'forge-vscode', 'extension.js'), "'use strict';\r\n");
    assert.strictEqual(refusal(() => vsix.buildVsix({ repo: crlf, version: VERSION })), 'crlf');
    const large = minimalRepo();
    fs.writeFileSync(path.join(large, 'extensions', 'forge-vscode', 'README.md'), Buffer.alloc(vsix.LIMITS.file + 1, 0x61));
    assert.strictEqual(refusal(() => vsix.buildVsix({ repo: large, version: VERSION })), 'size');
    assert.strictEqual(refusal(() => vsix.readPhysical(fs.realpathSync.native(large), 'bad name.js')), 'name');
    assert.strictEqual(refusal(() => vsix.readPhysical(fs.realpathSync.native(large), '../escape.js')), 'name');
    for (const [change, reason] of [[pkg => ({ ...pkg, name: 'other' }), 'identity'], [pkg => ({ ...pkg, publisher: 'someone' }), 'identity'],
      [pkg => ({ ...pkg, main: './other.js' }), 'identity'], [pkg => ({ ...pkg, engines: { vscode: '>=1.90.0' } }), 'engine-range'],
      [pkg => ({ ...pkg, engines: {} }), 'engine-range']]) {
      const repo = minimalRepo();
      const file = path.join(repo, 'extensions', 'forge-vscode', 'package.json');
      fs.writeFileSync(file, `${JSON.stringify(change(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2)}\n`);
      assert.strictEqual(refusal(() => vsix.buildVsix({ repo, version: VERSION })), reason);
    }
    for (const version of ['1.2', 'v1.2.3', '1.2.3-beta', '', undefined]) {
      assert.strictEqual(refusal(() => vsix.buildVsix({ repo: REPO, version })), 'version-invalid', String(version));
    }
  });

  test('links and junctions anywhere in the extension path are refused', () => {
    const repo = minimalRepo('link');
    const file = path.join(repo, 'extensions', 'forge-vscode', 'extension.js');
    const outside = path.join(root, 'outside.js');
    fs.writeFileSync(outside, "'use strict';\n");
    fs.unlinkSync(file);
    let linked = true;
    try { fs.symlinkSync(outside, file, 'file'); } catch (error) { linked = false; skip('file symlink refusal', `symlink not permitted (${error.code})`); }
    if (linked) assert.strictEqual(refusal(() => vsix.buildVsix({ repo, version: VERSION })), 'link');
    const dirRepo = minimalRepo('junction');
    const media = path.join(dirRepo, 'extensions', 'forge-vscode', 'media');
    const elsewhere = path.join(root, 'media elsewhere');
    fs.renameSync(media, elsewhere);
    let junction = true;
    try { fs.symlinkSync(elsewhere, media, process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { junction = false; skip('directory link refusal', `link not permitted (${error.code})`); }
    if (junction) assert.strictEqual(refusal(() => vsix.buildVsix({ repo: dirRepo, version: VERSION })), 'link');
  });

  test('verifyVsix accepts the build and refuses each tampering with a closed reason', () => {
    const expected = { sha256: built.sha256, version: VERSION };
    assert.deepStrictEqual({ ok: vsix.verifyVsix(built.bytes, expected).ok, reason: vsix.verifyVsix(built.bytes, expected).reason }, { ok: true, reason: null });
    const reason = (bytes, wanted = expected) => vsix.verifyVsix(bytes, wanted).reason;
    assert.strictEqual(reason(Buffer.concat([built.bytes, Buffer.from('x')])), 'trailing-bytes');
    const entries = vsix.extractEntries(built.bytes);
    const flipped = Buffer.from(built.bytes);
    const firstData = 30 + Buffer.byteLength(entries[0].name);
    flipped[firstData] ^= 0x01;
    assert.strictEqual(reason(flipped), 'crc-mismatch');
    const { records } = centralRecords(built.bytes);
    const method = Buffer.from(built.bytes);
    method.writeUInt16LE(8, records[0].at + 10);
    assert.strictEqual(reason(method), 'method');
    const size = Buffer.from(built.bytes);
    size.writeUInt32LE(size.readUInt32LE(records[0].at + 24) + 1, records[0].at + 24);
    assert.strictEqual(reason(size), 'size-mismatch');
    assert.strictEqual(reason(Buffer.from('not a zip at all, definitely not a zip')), 'malformed');
    const rebuild = list => vsix.writeZip(list);
    assert.strictEqual(reason(rebuild(entries.concat([{ name: 'extension/extra.js', bytes: Buffer.from('1\n') }]))), 'entry-extra');
    assert.strictEqual(reason(rebuild(entries.filter(entry => entry.name !== 'extension/README.md'))), 'entry-missing');
    assert.strictEqual(reason(rebuild([entries[1], entries[0], ...entries.slice(2)])), 'entry-order');
    const foreign = entries.map(entry => entry.name !== 'extension/package.json' ? entry
      : { name: entry.name, bytes: Buffer.from(JSON.stringify({ ...JSON.parse(entry.bytes), publisher: 'someone' })) });
    assert.strictEqual(reason(rebuild(foreign)), 'identity');
    assert.strictEqual(reason(built.bytes, { sha256: built.sha256, version: '7.8.8' }), 'version-mismatch');
    assert.strictEqual(reason(built.bytes, { sha256: 'a'.repeat(64), version: VERSION }), 'sha256-mismatch');
    assert.strictEqual(reason(rebuild(entries)), null, 'the strict reader round-trips the writer');
  });

  const interpreter = python();
  if (!interpreter) skip('independent zip reader (python3 zipfile)', 'python3 unavailable; not counted as approval');
  else test('independent reader: python zipfile lists the same entries and testzip() is None', () => {
    const file = path.join(root, 'independent Ω.vsix');
    fs.writeFileSync(file, built.bytes);
    const result = spawnSync(interpreter, ['-c', 'import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"names":z.namelist(),"test":z.testzip(),"methods":sorted({i.compress_type for i in z.infolist()})}))', file],
      { encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), { names: vsix.expectedNames(), test: null, methods: [0] });
  });

  test('CLI --json reports file, version and sha256; --output refuses to overwrite', () => {
    const { VERSION: product } = require('./forge-version.js');
    const expected = vsix.buildVsix({ repo: REPO, version: product });
    const json = spawnSync(process.execPath, [SCRIPT, '--repo', REPO, '--json'], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(json.status, 0, json.stderr);
    assert.deepStrictEqual(JSON.parse(json.stdout), { file_name: expected.file_name, version: product, sha256: expected.sha256 });
    const output = path.join(root, 'manual Ω.vsix');
    const first = spawnSync(process.execPath, [SCRIPT, '--repo', REPO, '--output', output, '--json'], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(sha256(fs.readFileSync(output)), expected.sha256);
    fs.writeFileSync(output, 'operator bytes');
    const second = spawnSync(process.execPath, [SCRIPT, '--repo', REPO, '--output', output], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(second.status, 1);
    assert.strictEqual(fs.readFileSync(output, 'utf8'), 'operator bytes');
    const refused = spawnSync(process.execPath, [SCRIPT, '--repo', path.join(root, 'no extension tree'), '--json'], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(refused.status, 1);
    assert.match(refused.stderr, /package-invalid tree-missing/);
  });
} finally { fs.rmSync(root, { recursive: true, force: true }); }

process.stdout.write(`\n${passed} passed, 0 failed, ${skipped} skipped\n`);
