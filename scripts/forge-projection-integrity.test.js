'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('./forge-memory');
const projection = require('./forge-projection');
const { serializeGroup } = require('./forge-grouped-file');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projection-integrity-')));
const read = fs.readFileSync;
const rename = fs.renameSync;
function fixture(name) {
  const cwd = path.join(root, name);
  fs.mkdirSync(path.join(cwd, '.gsd', 'memory'), { recursive: true });
  memory.writeFragment(cwd, { unit_id: 'M001', facts: [{ mem_id: 'MEM001', category: 'architecture', text: 'original content', created_at: '2026-01-01' }], stats: [] });
  return cwd;
}
try {
  const cwd = fixture('freshness');
  const fragment = memory.fragmentPath(cwd, 'M001');
  const output = path.join(cwd, '.gsd', 'AUTO-MEMORY.md');
  assert.strictEqual(projection.isStale(cwd).memory, true);
  projection.writeAll(cwd);
  assert.strictEqual(projection.isStale(cwd).memory, false);
  const stat = fs.statSync(fragment);
  fs.writeFileSync(fragment, read(fragment, 'utf8').replace('original content', 'modified content'));
  fs.utimesSync(fragment, stat.atime, stat.mtime);
  assert.strictEqual(projection.isStale(cwd).memory, true, 'same-size timestamp-restored content edit');
  projection.writeAll(cwd);
  const renamed = path.join(path.dirname(fragment), 'M002.md');
  fs.renameSync(fragment, renamed);
  assert.strictEqual(projection.isStale(cwd).memory, true);
  projection.writeAll(cwd);
  fs.unlinkSync(renamed);
  assert.strictEqual(projection.isStale(cwd).memory, true, 'last fragment deletion');
  assert.strictEqual(projection.writeAll(cwd).blocked.length, 0, 'generated monolith can become empty');
  assert(!read(output, 'utf8').includes('modified content'));
  assert.strictEqual(projection.isStale(cwd).memory, false);
  fs.unlinkSync(output);
  assert.strictEqual(projection.isStale(cwd).memory, true, 'missing output');

  const legacy = fixture('legacy');
  projection.writeAll(legacy);
  fs.unlinkSync(path.join(legacy, '.gsd', 'forge', 'projection-state.json'));
  fs.unlinkSync(memory.fragmentPath(legacy, 'M001'));
  assert(projection.writeAll(legacy).blocked.some(row => row.file.endsWith('AUTO-MEMORY.md')));
  const missing = fixture('missing-dir');
  projection.writeAll(missing);
  fs.rmSync(path.join(missing, '.gsd', 'memory'), { recursive: true });
  assert.strictEqual(projection.isStale(missing).memory, true);
  assert.strictEqual(projection.writeAll(missing).blocked.length, 0);
  assert(!read(path.join(missing, '.gsd', 'AUTO-MEMORY.md'), 'utf8').includes('original content'));
  assert.strictEqual(projection.isStale(missing).memory, false);
  const edited = fixture('missing-dir-edited-output');
  projection.writeAll(edited);
  fs.rmSync(path.join(edited, '.gsd', 'memory'), { recursive: true });
  const editedOutput = path.join(edited, '.gsd', 'AUTO-MEMORY.md');
  fs.appendFileSync(editedOutput, '\nUser-owned addition\n');
  const editedBytes = read(editedOutput);
  assert(projection.writeAll(edited).blocked.some(row => row.file.endsWith('AUTO-MEMORY.md')));
  assert.deepStrictEqual(read(editedOutput), editedBytes);

  for (const mode of ['unchanged', 'last-deleted', 'store-missing', 'edited', 'legacy']) {
    const upgraded = fixture(`renderer-${mode}`);
    projection.writeAll(upgraded);
    const receiptPath = path.join(upgraded, '.gsd', 'forge', 'projection-state.json');
    const receipt = JSON.parse(read(receiptPath));
    receipt.version = 'previous-renderer';
    for (const store of Object.values(receipt.stores)) delete store.version;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    const target = path.join(upgraded, '.gsd', 'AUTO-MEMORY.md');
    if (mode !== 'unchanged') fs.unlinkSync(memory.fragmentPath(upgraded, 'M001'));
    if (mode === 'store-missing') fs.rmSync(path.join(upgraded, '.gsd', 'memory'), { recursive: true });
    if (mode === 'edited') fs.appendFileSync(target, '\nUser-owned addition\n');
    if (mode === 'legacy') fs.unlinkSync(receiptPath);
    const before = read(target);
    assert.strictEqual(projection.isStale(upgraded).memory, true, 'renderer mismatch invalidates freshness');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = projection.writeAll(upgraded);
      if (['edited', 'legacy'].includes(mode)) {
        assert(result.blocked.some(row => row.file.endsWith('AUTO-MEMORY.md')));
        assert.deepStrictEqual(read(target), before);
        assert.strictEqual(projection.isStale(upgraded).memory, true);
      } else {
        assert.strictEqual(result.blocked.length, 0, 'renderer mismatch retains output provenance');
        assert.strictEqual(read(target, 'utf8').includes('original content'), mode === 'unchanged');
        assert.strictEqual(projection.isStale(upgraded).memory, false);
      }
    }
  }

  const failure = fixture('read-failure');
  projection.writeAll(failure);
  const protectedOutput = path.join(failure, '.gsd', 'AUTO-MEMORY.md');
  const prior = read(protectedOutput);
  fs.readFileSync = function(file, ...args) {
    if (fs.existsSync(file) && fs.realpathSync.native(file) === fs.realpathSync.native(memory.fragmentPath(failure, 'M001'))) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return read.call(fs, file, ...args);
  };
  assert.strictEqual(projection.isStale(failure).memory, true);
  assert.throws(() => projection.writeAll(failure), /fixture denied/);
  fs.readFileSync = read;
  assert.deepStrictEqual(read(protectedOutput), prior);
  memory.writeFragment(failure, { unit_id: 'M002', facts: [{ mem_id: 'MEM002', text: 'new', category: 'architecture' }], stats: [] });
  fs.renameSync = function(from, to) {
    if (path.resolve(String(to)) === path.resolve(protectedOutput)) throw Object.assign(new Error('fixture publication failed'), { code: 'EIO' });
    return rename.call(fs, from, to);
  };
  assert.throws(() => projection.writeAll(failure), /fixture publication failed/);
  fs.renameSync = rename;
  assert.deepStrictEqual(read(protectedOutput), prior);
  assert.strictEqual(projection.isStale(failure).memory, true);

  const nowMs = Date.parse('2026-09-22');
  for (const count of [10, 100, 500]) {
    let groupedCwd = path.join(root, `grouped-${count}`);
    if (count === 10) {
      fs.mkdirSync(groupedCwd);
      const alias = path.join(root, 'grouped-alias');
      fs.symlinkSync(groupedCwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
      groupedCwd = alias;
    }
    const dir = path.join(groupedCwd, '.gsd', 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const units = [];
    for (let i = 1; i <= count; i++) {
      const id = `M${String(i).padStart(3, '0')}`;
      const text = `---\nunit_id: ${id}\nfacts:\n  - mem_id: MEM001\n    category: architecture\n    text: fact ${i}\n    created_at: 2026-01-01\nstats: []\n---\n`;
      fs.writeFileSync(path.join(dir, `${id}.md`), text);
      units.push({ id, content: Buffer.from(text) });
    }
    const expected = projection.projectMemoryEntries(groupedCwd, { nowMs });
    const container = path.join(dir, '2026-Q1.md');
    fs.writeFileSync(container, serializeGroup({ epoch: '2026-Q1', units }).buffer);
    for (const unit of units) fs.unlinkSync(path.join(dir, `${unit.id}.md`));
    let reads = 0; let bytes = 0;
    fs.readFileSync = function(file, ...args) {
      const result = read.call(fs, file, ...args);
      if (fs.realpathSync.native(file) === fs.realpathSync.native(container)) { reads++; bytes += Buffer.byteLength(result); }
      return result;
    };
    const before = process.memoryUsage();
    const actual = projection.projectMemoryEntries(groupedCwd, { nowMs });
    const after = process.memoryUsage();
    fs.readFileSync = read;
    assert.deepStrictEqual(actual, expected);
    assert.strictEqual(reads, 1, 'container read once, independent of unit count');
    console.log(JSON.stringify({ units: count, reads, bytes, heapDelta: after.heapUsed - before.heapUsed, rss: after.rss, peakRssKiB: process.resourceUsage().maxRSS }));
    const entries = memory.listFragments(groupedCwd);
    const snapshot = memory.readFragmentText(groupedCwd, entries[0]);
    fs.writeFileSync(container, serializeGroup({ epoch: '2026-Q1', units: [units[units.length - 1]] }).buffer);
    assert.strictEqual(memory.readFragmentText(groupedCwd, entries[0]), snapshot);
    assert.strictEqual(memory.listFragments(groupedCwd).length, 1, 'new operation sees new container');
  }
  console.log('PASS projection integrity and grouped read parity');
} finally { fs.readFileSync = read; fs.renameSync = rename; fs.rmSync(root, { recursive: true, force: true }); }
