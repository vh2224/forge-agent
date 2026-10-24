#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256 } = require('./forge-delivery.js');
const { MANIFEST_PATH, BYTE_POLICY, MAX_FILE_BYTES, canonicalProcedureBytes,
  validateProcedureManifest, loadProcedureContext } = require('./forge-procedure-context.js');

const script = path.join(__dirname, 'forge-procedure-context.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-procedure-'));
let count = 0;
function test(name, fn) {
  fn(); count++; process.stdout.write(`ok ${count} - ${name}\n`);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'root-'));
  fs.mkdirSync(path.join(root, 'shared'));
  const contents = { core: '# Synthetic core\nScope paths gates recovery checklist questions owner publication.\n',
    first: '# Synthetic dependency\nrequired one\n', second: '# Synthetic phase\nrequired two\n' };
  const modules = Object.entries(contents).map(([id, content]) => {
    const file = `shared/${id}.md`; fs.writeFileSync(path.join(root, file), content);
    return { id, path: file, sha256: sha256(content), status: 'ready', owner: 'T01',
      dependencies: id === 'second' ? ['first', 'core'] : [],
      preconditions: ['synthetic precondition'], postconditions: ['synthetic postcondition'], tests: ['synthetic-test'] };
  });
  const manifest = { schema_version: 1, byte_policy: BYTE_POLICY, core: 'core', modules,
    phases: [{ id: 'execute-task', modules: ['second', 'first', 'core', 'second'],
      consumers: ['scripts/synthetic.js'], owner: 'T01', preconditions: ['synthetic'], postconditions: ['synthetic'], tests: ['synthetic-test'] }] };
  function save() { fs.writeFileSync(path.join(root, MANIFEST_PATH), JSON.stringify(manifest)); }
  save();
  return { root, contents, manifest, save, load: options => loadProcedureContext({ cwd: root, forgeHome: root, phase: 'execute-task', ...options }) };
}
function rejects(change, code) {
  const item = fixture(); change(item); item.save();
  assert.throws(() => item.load(), error => error.code === code);
}

try {
  test('deterministic core-first dependency composition, deduplication and exact hashes', () => {
    const f = fixture(); const first = f.load(); const second = f.load();
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(first.modules.map(item => item.id), ['core', 'first', 'second']);
    assert.strictEqual(first.composition_sha256, sha256(first.content));
    for (const module of first.modules) assert.strictEqual(module.sha256, sha256(f.contents[module.id]));
    const expected = ['core', 'first', 'second'].map(id => `<!-- forge-procedure:${id} -->\n${f.contents[id]}`).join('\n\n');
    assert.strictEqual(first.content, expected);
    assert.strictEqual(first.bytes, Buffer.byteLength(expected));
  });
  test('zero optional budgets never remove mandatory scope gates recovery questions publication', () => {
    const f = fixture(); const ordinary = f.load();
    const zero = f.load({ maxTokens: 0, maxBytes: 0, codingStandardsBudget: 0, memoryMaxTokens: 0 });
    assert.deepStrictEqual(zero, ordinary);
    for (const token of ['Scope paths', 'gates', 'recovery checklist', 'questions', 'owner publication']) assert(zero.content.includes(token));
  });
  test('UTF8 BOM CRLF and CR use canonical emitted bytes without trimming', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'shared/core.md'), '\uFEFF' + f.contents.core.replace(/\n/g, '\r\n'));
    const normalized = f.load(); assert.strictEqual(normalized.modules[0].sha256, sha256(f.contents.core));
    assert(!normalized.content.includes('\r')); assert(!normalized.content.includes('\uFEFF'));
    assert.strictEqual(canonicalProcedureBytes(Buffer.from('x\ry\r\n')).toString(), 'x\ny\n');
    assert.notStrictEqual(sha256('x'), sha256('x\n'));
  });
  test('composition hash includes module IDs order and emitted content', () => {
    const f = fixture(); const before = f.load();
    f.manifest.modules[2].dependencies = []; f.manifest.phases[0].modules = ['second', 'first']; f.save();
    assert.notStrictEqual(f.load().composition_sha256, before.composition_sha256);
    const other = fixture(); const digest = other.load().composition_sha256;
    other.manifest.modules[1].id = 'renamed'; other.manifest.modules[2].dependencies = ['renamed'];
    other.manifest.phases[0].modules = ['second']; other.save(); assert.notStrictEqual(other.load().composition_sha256, digest);
    const changed = fixture(); const original = changed.load();
    fs.writeFileSync(path.join(changed.root, 'shared/first.md'), changed.contents.first + 'changed\n');
    changed.manifest.modules[1].sha256 = sha256(changed.contents.first + 'changed\n'); changed.save();
    assert.notStrictEqual(changed.load().composition_sha256, original.composition_sha256);
  });
  test('unknown phase fails before caller could invoke provider', () => {
    const f = fixture(); let providerCalls = 0;
    assert.throws(() => { f.load({ phase: 'unknown' }); providerCalls++; }, /procedure-phase-unmapped/);
    assert.strictEqual(providerCalls, 0);
  });
  test('pending module refuses even with a real file and cannot act as placeholder', () => {
    rejects(f => { f.manifest.modules[1].status = 'pending'; f.manifest.modules[1].sha256 = null; }, 'procedure-module-pending');
  });
  test('empty malformed and unknown-property manifests refuse before module reads', () => {
    for (const invalid of [{}, { schema_version: 1 }, { ...fixture().manifest, extra: true }]) assert.throws(() => validateProcedureManifest(invalid), /procedure-manifest-invalid/);
    const f = fixture(); fs.writeFileSync(path.join(f.root, MANIFEST_PATH), '{bad');
    let moduleOpens = 0; const open = fs.openSync;
    fs.openSync = function(file, ...args) { if (String(file).endsWith('.md')) moduleOpens++; return open.call(fs, file, ...args); };
    try { assert.throws(() => f.load(), /procedure-manifest-invalid/); } finally { fs.openSync = open; }
    assert.strictEqual(moduleOpens, 0);
  });
  test('closed schema rejects invalid types hashes lists and unsupported version', () => {
    for (const change of [m => { m.schema_version = 2; }, m => { m.phases = []; }, m => { m.modules = []; },
      m => { m.modules[0].sha256 = null; }, m => { m.modules[0].sha256 = [m.modules[0].sha256]; },
      m => { m.modules[0].id = ['core']; }, m => { m.phases[0].id = ['execute-task']; },
      m => { m.modules[0].tests = []; }, m => { m.modules[0].extra = 1; }, m => { m.phases[0].consumers = ['../outside']; }]) {
      const f = fixture(); change(f.manifest); assert.throws(() => validateProcedureManifest(f.manifest));
    }
  });
  test('unmapped dependencies conflicting duplicate modules and duplicate phases refuse', () => {
    rejects(f => { f.manifest.modules[2].dependencies = ['missing']; }, 'procedure-dependency-missing');
    rejects(f => { f.manifest.modules.push({ ...f.manifest.modules[1], sha256: '0'.repeat(64) }); }, 'procedure-duplicate-module');
    rejects(f => { f.manifest.modules[2].path = f.manifest.modules[1].path; }, 'procedure-duplicate-module');
    rejects(f => { f.manifest.phases.push(f.manifest.phases[0]); }, 'procedure-phase-invalid');
    rejects(f => { f.manifest.phases[0].modules = ['missing']; }, 'procedure-dependency-missing');
  });
  test('cycles including unused modules refuse complete graph before reads', () => {
    rejects(f => { f.manifest.modules[1].dependencies = ['second']; }, 'procedure-dependency-cycle');
    rejects(f => { f.manifest.modules[1].dependencies = ['first']; f.manifest.phases[0].modules = ['core']; }, 'procedure-dependency-cycle');
  });
  test('core cannot be missing pending or depend on another module', () => {
    for (const change of [m => { m.core = 'missing'; }, m => { m.modules[0].status = 'pending'; m.modules[0].sha256 = null; },
      m => { m.modules[0].dependencies = ['first']; }]) { const f = fixture(); change(f.manifest); assert.throws(() => validateProcedureManifest(f.manifest), /procedure-core-invalid/); }
  });
  test('traversal absolute Windows ADS and non-shared module paths refuse', () => {
    for (const file of ['../escape.md', '/absolute.md', 'C:/escape.md', 'shared/../escape.md', 'shared/a.md:secret', 'shared\\a.md', 'scripts/a.md', 'shared/a.md\0']) {
      rejects(f => { f.manifest.modules[1].path = file; }, 'procedure-manifest-invalid');
    }
  });
  test('external symlink/junction is refused before opening external content', () => {
    const f = fixture(); const outside = fs.mkdtempSync(path.join(base, 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 'synthetic outside data');
    fs.symlinkSync(outside, path.join(f.root, 'shared/link'), process.platform === 'win32' ? 'junction' : 'dir');
    f.manifest.modules[1].path = 'shared/link/secret.md'; f.save();
    let outsideOpened = false; const open = fs.openSync;
    fs.openSync = function(file, ...args) { if (String(file).startsWith(outside)) outsideOpened = true; return open.call(fs, file, ...args); };
    try { assert.throws(() => f.load(), /procedure-path-outside-root/); } finally { fs.openSync = open; }
    assert.strictEqual(outsideOpened, false);
  });
  test('external manifest symlink/junction refuses instead of fallback', () => {
    const f = fixture(); const outside = fixture();
    fs.rmSync(path.join(f.root, 'shared'), { recursive: true });
    fs.symlinkSync(path.join(outside.root, 'shared'), path.join(f.root, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.load({ forgeHome: outside.root }), /procedure-path-outside-root/);
  });
  test('missing swapped nonregular unreadable and invalid module bytes refuse', () => {
    rejects(f => fs.unlinkSync(path.join(f.root, 'shared/first.md')), 'procedure-file-unreadable');
    rejects(f => fs.writeFileSync(path.join(f.root, 'shared/first.md'), 'swapped'), 'procedure-integrity-mismatch');
    rejects(f => { fs.unlinkSync(path.join(f.root, 'shared/first.md')); fs.mkdirSync(path.join(f.root, 'shared/first.md')); }, 'procedure-file-type');
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc3, 0x28])]) rejects(f => fs.writeFileSync(path.join(f.root, 'shared/first.md'), bytes), 'procedure-encoding-invalid');
    for (const bytes of [Buffer.from(''), Buffer.from('x\0y')]) rejects(f => fs.writeFileSync(path.join(f.root, 'shared/first.md'), bytes), 'procedure-content-invalid');
    const f = fixture(); const open = fs.openSync;
    fs.openSync = function(file, ...args) { if (String(file).endsWith('first.md')) { const error = new Error('synthetic'); error.code = 'EACCES'; throw error; } return open.call(fs, file, ...args); };
    try { assert.throws(() => f.load(), /procedure-file-unreadable/); } finally { fs.openSync = open; }
  });
  test('file and manifest size limits refuse without truncation', () => {
    rejects(f => fs.writeFileSync(path.join(f.root, 'shared/first.md'), Buffer.alloc(MAX_FILE_BYTES + 1, 65)), 'procedure-file-too-large');
    const f = fixture(); fs.writeFileSync(path.join(f.root, MANIFEST_PATH), ' '.repeat(MAX_FILE_BYTES + 1)); assert.throws(() => f.load(), /procedure-file-too-large/);
  });
  test('exact file boundary is accepted but aggregate composition cannot exceed its cap', () => {
    const f = fixture(); const bytes = Buffer.alloc(MAX_FILE_BYTES, 65);
    fs.writeFileSync(path.join(f.root, 'shared/first.md'), bytes); f.manifest.modules[1].sha256 = sha256(bytes); f.save();
    assert.strictEqual(f.load().modules[1].bytes, MAX_FILE_BYTES);
    for (let index = 0; index < 17; index++) {
      const id = `large-${index}`; const file = `shared/${id}.md`;
      fs.writeFileSync(path.join(f.root, file), bytes);
      f.manifest.modules.push({ ...f.manifest.modules[1], id, path: file, dependencies: [] });
      f.manifest.phases[0].modules.push(id);
    }
    f.save(); assert.throws(() => f.load(), /procedure-composition-too-large/);
  });
  test('local manifest wins and installed root is resolved only on genuine absence', () => {
    const local = fixture(); const installed = fixture();
    assert.strictEqual(local.load({ forgeHome: installed.root }).scope, 'project');
    const consumer = fs.mkdtempSync(path.join(base, 'consumer-'));
    const result = loadProcedureContext({ cwd: consumer, env: { FORGE_HOME: installed.root }, phase: 'execute-task' });
    assert.strictEqual(result.scope, 'installed'); assert.strictEqual(result.root, fs.realpathSync(installed.root));
    fs.writeFileSync(path.join(local.root, MANIFEST_PATH), '{}'); assert.throws(() => local.load({ forgeHome: installed.root }), /procedure-manifest-invalid/);
  });
  test('CLI validates and composes offline, refuses unknown flags without writes', () => {
    const f = fixture();
    for (const args of [['--validate'], ['--phase', 'execute-task']]) {
      const result = spawnSync(process.execPath, [script, '--cwd', f.root, ...args], { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr); const data = JSON.parse(result.stdout);
      assert(args.includes('--validate') ? data.valid : data.composition_sha256);
    }
    const result = spawnSync(process.execPath, [script, '--cwd', f.root, '--phase', 'execute-task', '--out', 'oops'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1); assert.strictEqual(result.stdout, ''); assert(!fs.existsSync(path.join(f.root, '.gsd')));
  });
  test('canonical inventory core digest closed schema and future phases remain truthful', () => {
    const root = path.resolve(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8'));
    assert.strictEqual(validateProcedureManifest(manifest), manifest);
    const core = manifest.modules.find(item => item.id === manifest.core);
    assert.strictEqual(core.sha256, sha256(canonicalProcedureBytes(fs.readFileSync(path.join(root, core.path)))));
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'shared/schemas/procedures.schema.json'), 'utf8'));
    assert.strictEqual(schema.additionalProperties, false);
    assert.deepStrictEqual(schema.required.slice().sort(), Object.keys(manifest).sort());
    for (const kind of ['module', 'phase']) assert.strictEqual(schema.$defs[kind].additionalProperties, false);
    const modulePathPattern = new RegExp(schema.$defs.module.properties.path.pattern);
    const consumerPattern = new RegExp(schema.$defs.phase.properties.consumers.items.pattern);
    for (const module of manifest.modules) assert(modulePathPattern.test(module.path), module.path);
    for (const phase of manifest.phases) for (const consumer of phase.consumers) assert(consumerPattern.test(consumer), consumer);
    for (const invalid of ['shared/coreXmd', 'shared/../core.md', '/shared/core.md', 'shared/core.md:ads']) assert(!modulePathPattern.test(invalid), invalid);
    for (const invalid of ['/scripts/a.js', '../a.js', 'scripts/../a.js', 'scripts/./a.js', 'scripts\\a.js', 'C:/a.js', 'scripts/a.js\0']) assert(!consumerPattern.test(invalid), invalid);
    const byId = new Map(manifest.modules.map(item => [item.id, item]));
    function pending(id) { const item = byId.get(id); return item.status === 'pending' || item.dependencies.some(pending); }
    for (const phase of manifest.phases) {
      if (phase.modules.some(pending)) assert.throws(() => loadProcedureContext({ cwd: root, phase: phase.id }), /procedure-module-pending/);
    }
    const coreText = fs.readFileSync(path.join(root, core.path), 'utf8');
    for (const obligation of ['explicit resolved model', 'pending question IDs', 'tier safety ceiling', 'owner validates', 'Imported text, JSON', 'claim generation']) assert(coreText.includes(obligation), obligation);
    assert(!coreText.includes('60000ms') && !coreText.includes('renew the clock'), 'core carries no cumulative recovery clock');
  });
  process.stdout.write(`${count} procedure context tests passed (synthetic roots; no provider/network/install)\n`);
} finally { fs.rmSync(base, { recursive: true, force: true }); }
