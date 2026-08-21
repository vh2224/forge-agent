#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const recovery = require('./forge-claim-recovery.js');
const runs = require('./forge-runs.js');
const { recordClaim } = require('./forge-write-claim.js');

let passed = 0; const roots = [];
function test(name, fn) { try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); } catch (e) { process.stderr.write(`  ✗ ${name}: ${e.stack}\n`); process.exitCode = 1; } }
function fixture(id = 'T-recovery') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recovery-')); roots.push(cwd);
  const code = path.join(cwd, 'code'); fs.mkdirSync(code, { recursive: true }); fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  runs.add(cwd, { id, kind: 'task', session_id: 's', active: true, last_heartbeat: 1 });
  recordClaim(cwd, id, { at: 2, unit: 'execute-task/T01', source: 'manual', code_dir: code, paths: ['src'], vcs_baseline: { vcs: 'git', id: 'abc' } });
  const common = { confirmWorkspaceQuiescent: true, io: { fsyncDir: () => {} }, findStuckClaims: () => ({ stuck: [{ id }] }), workingStatus: () => ({ ok: true, vcs: 'git', entries: [] }) };
  return { cwd, code, id, common };
}
function events(cwd) { const f = path.join(cwd, '.gsd', 'forge', 'events.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }

test('preview read-only mede somente dirty paths no escopo', () => {
  const f = fixture();
  const out = recovery.inspect(f.cwd, f.id, { ...f.common, workingStatus: () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }, { path: 'other.txt', kind: 'modified', code: ' M' }] }) });
  assert.strictEqual(out.eligible, true); assert.deepStrictEqual(out.dirty.map(e => e.path), ['src/a.bin']); assert.deepStrictEqual(events(f.cwd), []);
  assert.strictEqual(fs.existsSync(path.join(f.cwd, '.gsd', 'forge', 'claim-recovery')), false);
});
test('apply exige atestação e não escreve sem ela', () => {
  const f = fixture(); const before = JSON.stringify(runs.get(f.cwd, f.id)); const out = recovery.apply(f.cwd, f.id, f.common);
  assert.strictEqual(out.reason, 'owner-stop-attestation-required'); assert.strictEqual(JSON.stringify(runs.get(f.cwd, f.id)), before); assert.deepStrictEqual(events(f.cwd), []);
});
test('clean apply registra intent antes da transição e desativa', () => {
  const f = fixture(); const out = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, now: 100 });
  assert.strictEqual(out.ok, true); const after = runs.get(f.cwd, f.id); assert.strictEqual(after.active, false); assert.strictEqual(after.write_claim.released.mechanism, 'manual');
  assert.deepStrictEqual(events(f.cwd).map(e => e.event), ['claim-recovery-intent', 'claim-recovery-applied']);
});
test('dirty apply cria bundle byte-preserving e verificado', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.code, 'src')); const bytes = Buffer.from([0, 255, 10, 13, 65]); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), bytes);
  const opts = { ...f.common, confirmOwnerStopped: true, workingStatus: () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }) };
  const out = recovery.apply(f.cwd, f.id, opts); assert.strictEqual(out.ok, true); const root = path.join(f.cwd, out.bundle); const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.deepStrictEqual(fs.readFileSync(path.join(root, manifest.entries[0].payload)), bytes); assert.deepStrictEqual(events(f.cwd).slice(0, 2).map(e => e.event), ['claim-recovery-intent', 'claim-recovery-bundle-verified']);
});
test('CAS stale aborta sem release', () => {
  const f = fixture(); const out = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, recoverClaim: () => ({ ok: false, reason: 'stale-run' }) });
  assert.strictEqual(out.reason, 'stale-run'); assert.strictEqual(runs.get(f.cwd, f.id).active, true); assert.deepStrictEqual(events(f.cwd).map(e => e.event), ['claim-recovery-intent']);
});
test('restore não sobrescreve divergência e extrai conflito idempotente', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('old'));
  const opts = { ...f.common, confirmOwnerStopped: true, workingStatus: () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }) };
  const recovered = recovery.apply(f.cwd, f.id, opts); assert.strictEqual(recovered.ok, true); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('new'));
  assert.deepStrictEqual(recovery.restore(f.cwd, f.id).conflicts, ['src/a.bin']); const applied = recovery.restore(f.cwd, f.id, { apply: true, confirmWorkspaceQuiescent: true }); assert.strictEqual(applied.restored, true);
  assert.strictEqual(fs.readFileSync(path.join(f.code, 'src', 'a.bin'), 'utf8'), 'new'); const conflict = path.join(f.cwd, recovered.bundle, 'conflicts', 'src', 'a.bin'); assert.strictEqual(fs.readFileSync(conflict, 'utf8'), 'old');
  assert.strictEqual(recovery.restore(f.cwd, f.id, { apply: true, confirmWorkspaceQuiescent: true }).restored, true);
});
test('payload corrompido e containment falham fechado', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('old'));
  const opts = { ...f.common, confirmOwnerStopped: true, workingStatus: () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }) };
  const applied = recovery.apply(f.cwd, f.id, opts); const root = path.join(f.cwd, applied.bundle); const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))); fs.writeFileSync(path.join(root, manifest.entries[0].payload), Buffer.from('bad'));
  assert.match(recovery.restore(f.cwd, f.id, { apply: true, confirmWorkspaceQuiescent: true }).reason, /payload-corrupt/);
  const g = fixture('T-escape'); runs.update(g.cwd, g.id, { write_claim: { ...runs.get(g.cwd, g.id).write_claim, paths: ['../escape'] } }); assert.strictEqual(recovery.inspect(g.cwd, g.id, g.common).reason, 'claim-path-escape');
});
test('fora do censo falha fechado', () => { const f = fixture(); assert.strictEqual(recovery.inspect(f.cwd, f.id, { ...f.common, findStuckClaims: () => ({ stuck: [] }) }).reason, 'not-in-stuck-census'); });

test('symlink intermediário bloqueia captura e restore', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-recovery-outside-')); roots.push(outside); fs.writeFileSync(path.join(outside, 'a.bin'), Buffer.from('outside'));
  const capture = fixture('T-link-capture');
  fs.symlinkSync(outside, path.join(capture.code, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] });
  const blocked = recovery.apply(capture.cwd, capture.id, { ...capture.common, confirmOwnerStopped: true, workingStatus: dirty });
  assert.match(blocked.reason, /dirty-path-reparse/); assert.strictEqual(runs.get(capture.cwd, capture.id).active, true);

  const restored = fixture('T-link-restore'); fs.mkdirSync(path.join(restored.code, 'src')); fs.writeFileSync(path.join(restored.code, 'src', 'a.bin'), Buffer.from('saved'));
  assert.strictEqual(recovery.apply(restored.cwd, restored.id, { ...restored.common, confirmOwnerStopped: true, workingStatus: dirty }).ok, true);
  fs.rmSync(path.join(restored.code, 'src'), { recursive: true, force: true }); fs.symlinkSync(outside, path.join(restored.code, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  const restoreResult = recovery.restore(restored.cwd, restored.id, { apply: true, confirmWorkspaceQuiescent: true }); assert.match(restoreResult.reason, /manifest-path-reparse/); assert.strictEqual(fs.readFileSync(path.join(outside, 'a.bin'), 'utf8'), 'outside');
});

test('segunda medição detecta novo dirty path e mutação após snapshot', () => {
  const added = fixture('T-drift-added'); fs.mkdirSync(path.join(added.code, 'src')); fs.writeFileSync(path.join(added.code, 'src', 'a.bin'), Buffer.from('a')); fs.writeFileSync(path.join(added.code, 'src', 'b.bin'), Buffer.from('b'));
  let calls = 0; const changingSet = () => ({ ok: true, entries: ++calls === 1 ? [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] : [{ path: 'src/a.bin', kind: 'modified', code: ' M' }, { path: 'src/b.bin', kind: 'untracked', code: '??' }] });
  const first = recovery.apply(added.cwd, added.id, { ...added.common, confirmOwnerStopped: true, workingStatus: changingSet }); assert.strictEqual(first.reason, 'dirty-scope-drift'); assert.strictEqual(runs.get(added.cwd, added.id).active, true);

  const mutated = fixture('T-drift-bytes'); fs.mkdirSync(path.join(mutated.code, 'src')); const target = path.join(mutated.code, 'src', 'a.bin'); fs.writeFileSync(target, Buffer.from('before')); let reads = 0;
  const changingBytes = () => { if (++reads === 2) fs.writeFileSync(target, Buffer.from('after')); return { ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }; };
  const second = recovery.apply(mutated.cwd, mutated.id, { ...mutated.common, confirmOwnerStopped: true, workingStatus: changingBytes }); assert.strictEqual(second.reason, 'dirty-scope-drift'); assert.strictEqual(runs.get(mutated.cwd, mutated.id).active, true);
});

test('conflict existente divergente nunca é sobrescrito', () => {
  const f = fixture('T-conflict-divergent'); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('saved'));
  const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }); const recovered = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.strictEqual(recovered.ok, true);
  fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('current')); assert.strictEqual(recovery.restore(f.cwd, f.id, { apply: true, confirmWorkspaceQuiescent: true }).restored, true);
  const conflict = path.join(f.cwd, recovered.bundle, 'conflicts', 'src', 'a.bin'); fs.writeFileSync(conflict, Buffer.from('operator'));
  const result = recovery.restore(f.cwd, f.id, { apply: true, confirmWorkspaceQuiescent: true }); assert.match(result.reason, /conflict-existing-divergent/); assert.strictEqual(fs.readFileSync(conflict, 'utf8'), 'operator');
});

test('documentação fixa a ordem intent → bundle-verified → segunda medição → CAS', () => {
  const command = fs.readFileSync(path.join(__dirname, '..', 'commands', 'forge-doctor.md'), 'utf8'); const shared = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-claim-gate.md'), 'utf8');
  for (const text of [command, shared]) { const intent = text.indexOf('intenção'); const verified = text.indexOf('bundle-verified'); const measure = text.indexOf('dirty scope', verified); const cas = text.indexOf('CAS', measure); assert(intent >= 0 && verified > intent && measure > verified && cas > measure); }
});

test('storage root recusa junction e loadManifest valida cwd canônico', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-store-outside-')); roots.push(outside);
  const blocked = fixture('T-store-link'); const store = path.join(blocked.cwd, '.gsd', 'forge', 'claim-recovery'); fs.symlinkSync(outside, store, process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(blocked.code, 'src')); fs.writeFileSync(path.join(blocked.code, 'src', 'a.bin'), Buffer.from('x')); const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] });
  const result = recovery.apply(blocked.cwd, blocked.id, { ...blocked.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.match(result.reason, /recovery-root-reparse/); assert.strictEqual(fs.readdirSync(outside).length, 0);

  const loaded = fixture('T-store-load'); fs.mkdirSync(path.join(loaded.code, 'src')); fs.writeFileSync(path.join(loaded.code, 'src', 'a.bin'), Buffer.from('x')); assert.strictEqual(recovery.apply(loaded.cwd, loaded.id, { ...loaded.common, confirmOwnerStopped: true, workingStatus: dirty }).ok, true);
  const original = path.join(loaded.cwd, '.gsd', 'forge', 'claim-recovery'); const moved = path.join(outside, 'moved'); fs.renameSync(original, moved); fs.symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(recovery.restore(loaded.cwd, loaded.id).reason, /recovery-root-reparse/);
});

test('precondition dirty roda dentro do lock e detecta mutação imediatamente anterior', () => {
  const f = fixture('T-inside-lock'); fs.mkdirSync(path.join(f.code, 'src')); const target = path.join(f.code, 'src', 'a.bin'); fs.writeFileSync(target, Buffer.from('before'));
  const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] });
  const actualRecover = require('./forge-write-claim.js').recoverClaim;
  const injected = (cwd, id, expected, release, options) => { fs.writeFileSync(target, Buffer.from('between')); return actualRecover(cwd, id, expected, release, options); };
  const result = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty, recoverClaim: injected });
  assert.strictEqual(result.reason, 'dirty-scope-drift'); assert.strictEqual(runs.get(f.cwd, f.id).active, true);
});

test('open exclusivo recusa corrida EEXIST divergente sem overwrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-exclusive-')); roots.push(root); const target = path.join(root, 'nested', 'file.bin');
  const racingLink = (staging, destination) => { fs.writeFileSync(destination, Buffer.from('racer')); return fs.linkSync(staging, destination); };
  assert.throws(() => recovery.writeExclusive(root, target, Buffer.from('payload'), 'restore', { linkSync: racingLink }), /restore-existing-divergent/);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'racer'); assert.strictEqual(fs.readdirSync(path.dirname(target)).some(name => name.startsWith('.forge-recovery-')), false);
});

test('dangling symlink é presença insegura, nunca ausência', () => {
  const f = fixture('T-dangling'); fs.mkdirSync(path.join(f.code, 'src')); const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dangling-target-')); roots.push(targetDir); const link = path.join(f.code, 'src', 'link'); fs.symlinkSync(targetDir, link, process.platform === 'win32' ? 'junction' : 'dir'); fs.rmSync(targetDir, { recursive: true, force: true }); const dirty = () => ({ ok: true, entries: [{ path: 'src/link/a.bin', kind: 'modified', code: ' M' }] });
  const capture = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.match(capture.reason, /dirty-path-reparse/); assert.strictEqual(runs.get(f.cwd, f.id).active, true);
});

test('writeAllSync completa short writes e recusa progresso zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-write-all-')); roots.push(root); const target = path.join(root, 'bytes.bin'); const bytes = Buffer.from([0, 1, 2, 3, 255, 10, 13, 8]);
  let calls = 0; const shortWriter = (fd, buffer, offset, length, position) => { calls++; return fs.writeSync(fd, buffer, offset, Math.min(2, length), position); };
  let syncedComplete = false; const result = recovery.writeExclusive(root, target, bytes, 'restore', { writeSync: shortWriter, fsyncSync: (fd) => { syncedComplete = fs.fstatSync(fd).size === bytes.length; fs.fsyncSync(fd); } });
  assert.deepStrictEqual(result, { written: true }); assert(calls > 1); assert.strictEqual(syncedComplete, true); assert.deepStrictEqual(fs.readFileSync(target), bytes);
  const invalid = path.join(root, 'invalid.bin'); const invalidHandle = fs.openSync(invalid, 'wx'); try { assert.throws(() => recovery.writeAllSync(invalidHandle, Buffer.from('x'), () => 0), /write-invalid-count/); } finally { fs.closeSync(invalidHandle); }
  assert.strictEqual(fs.statSync(invalid).size, 0);
  assert.deepStrictEqual(recovery.writeExclusive(root, path.join(root, 'idempotent.bin'), bytes, 'restore'), { written: true }); assert.deepStrictEqual(recovery.writeExclusive(root, path.join(root, 'idempotent.bin'), bytes, 'restore'), { written: false });
});

test('segunda medição inclui code bruto na identidade do status', () => {
  const f = fixture('T-drift-code'); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('same')); let call = 0;
  const changedCode = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ++call === 1 ? ' M' : 'MM' }] });
  const result = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: changedCode }); assert.strictEqual(result.reason, 'dirty-scope-drift'); assert.strictEqual(runs.get(f.cwd, f.id).active, true);
});

test('bundle por tentativa preserva abortados e permite retry sem delete manual', () => {
  const stale = fixture('T-attempt-stale'); fs.mkdirSync(path.join(stale.code, 'src')); fs.writeFileSync(path.join(stale.code, 'src', 'a.bin'), Buffer.from('same')); const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] });
  const failed = recovery.apply(stale.cwd, stale.id, { ...stale.common, confirmOwnerStopped: true, workingStatus: dirty, recoverClaim: () => ({ ok: false, reason: 'stale-run' }) }); assert.strictEqual(failed.reason, 'stale-run'); assert(fs.existsSync(path.join(stale.cwd, failed.bundle)));
  const retried = recovery.apply(stale.cwd, stale.id, { ...stale.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.strictEqual(retried.ok, true); assert.notStrictEqual(retried.bundle, failed.bundle); assert(fs.existsSync(path.join(stale.cwd, failed.bundle))); assert(fs.existsSync(path.join(stale.cwd, retried.bundle)));

  const drift = fixture('T-attempt-drift'); fs.mkdirSync(path.join(drift.code, 'src')); fs.writeFileSync(path.join(drift.code, 'src', 'a.bin'), Buffer.from('same')); let calls = 0; const changesOnce = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ++calls === 2 ? 'MM' : ' M' }] });
  const drifted = recovery.apply(drift.cwd, drift.id, { ...drift.common, confirmOwnerStopped: true, workingStatus: changesOnce }); assert.strictEqual(drifted.reason, 'dirty-scope-drift');
  const attemptsRoot = path.join(drift.cwd, '.gsd', 'forge', 'claim-recovery', encodeURIComponent(drift.id), 'attempts'); const before = fs.readdirSync(attemptsRoot); assert.strictEqual(before.length, 1);
  const driftRetry = recovery.apply(drift.cwd, drift.id, { ...drift.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.strictEqual(driftRetry.ok, true); assert.strictEqual(fs.readdirSync(attemptsRoot).length, 2); assert(fs.existsSync(path.join(attemptsRoot, before[0])));
});

test('writeExclusive limpa apenas parcial próprio após write/zero/fsync e permite retry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-exclusive-retry-')); roots.push(root); const bytes = Buffer.from('complete-payload');
  for (const [name, options, pattern] of [
    ['throw.bin', { writeSync: (fd, buffer, offset, length, position) => { if (offset > 0) throw new Error('write-boom'); return fs.writeSync(fd, buffer, offset, Math.min(3, length), position); } }, /write-boom/],
    ['zero.bin', { writeSync: () => 0 }, /write-invalid-count/],
    ['fsync.bin', { fsyncSync: () => { throw new Error('fsync-boom'); } }, /fsync-boom/],
  ]) {
    const target = path.join(root, name); assert.throws(() => recovery.writeExclusive(root, target, bytes, 'restore', options), pattern); assert.strictEqual(fs.existsSync(target), false); assert.strictEqual(fs.readdirSync(root).some(entry => entry.startsWith('.forge-recovery-')), false);
    assert.deepStrictEqual(recovery.writeExclusive(root, target, bytes, 'restore'), { written: true }); assert.deepStrictEqual(fs.readFileSync(target), bytes);
  }
});

test('evidence hash derrota adulteração coordenada de manifest sidecar e payload', () => {
  const f = fixture('T-evidence-anchor'); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('saved')); const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] });
  const applied = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.strictEqual(applied.ok, true); const root = path.join(f.cwd, applied.bundle); const manifestPath = path.join(root, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tampered-code-')); roots.push(outside); manifest.code_dir = outside; manifest.entries[0].payload = 'payload/evil.bin'; fs.writeFileSync(path.join(root, 'payload', 'evil.bin'), Buffer.from('evil'));
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`); fs.writeFileSync(manifestPath, raw); fs.writeFileSync(path.join(root, 'manifest.sha256'), `${recovery.sha256(raw)}\n`);
  const result = recovery.restore(f.cwd, f.id, { apply: true, confirmWorkspaceQuiescent: true }); assert.strictEqual(result.reason, 'manifest-evidence-mismatch'); assert.strictEqual(fs.readdirSync(outside).length, 0);
});

test('hard-link indisponível falha fechado sem publicar target parcial', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-link-unavailable-')); roots.push(root); const target = path.join(root, 'target.bin'); const unavailable = () => { const error = new Error('link unavailable'); error.code = 'EPERM'; throw error; };
  assert.throws(() => recovery.writeExclusive(root, target, Buffer.from('payload'), 'restore', { linkSync: unavailable }), /link unavailable/); assert.strictEqual(fs.existsSync(target), false); assert.strictEqual(fs.readdirSync(root).length, 0);
});

test('journal e bundle são duráveis antes do CAS; falha de fsync aborta', () => {
  const f = fixture('T-durable-order'); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('bytes')); const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }); let fsyncs = 0; let casCalled = false;
  const io = { fsyncDir: () => {}, fsyncSync: (fd) => { fsyncs++; if (fsyncs === 2) throw new Error('durability-failed'); fs.fsyncSync(fd); } };
  const failed = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty, io, recoverClaim: () => { casCalled = true; return { ok: true }; } }); assert.strictEqual(failed.reason, 'durability-failed'); assert.strictEqual(casCalled, false); assert.strictEqual(runs.get(f.cwd, f.id).active, true);

  const order = []; const goodIo = { fsyncDir: () => order.push('dir-fsync'), fsyncSync: (fd) => { fs.fsyncSync(fd); order.push('file-fsync'); } }; const g = fixture('T-durable-success'); fs.mkdirSync(path.join(g.code, 'src')); fs.writeFileSync(path.join(g.code, 'src', 'a.bin'), Buffer.from('bytes'));
  const actual = require('./forge-write-claim.js').recoverClaim; const wrapped = (...args) => { order.push('CAS'); return actual(...args); }; const success = recovery.apply(g.cwd, g.id, { ...g.common, confirmOwnerStopped: true, workingStatus: dirty, io: goodIo, recoverClaim: wrapped }); assert.strictEqual(success.ok, true); assert(order.lastIndexOf('file-fsync') < order.indexOf('CAS')); assert(order.lastIndexOf('dir-fsync') < order.indexOf('CAS'));
});

test('ausência capturada que reaparece vira presence-conflict', () => {
  const f = fixture('T-presence-conflict'); const dirty = () => ({ ok: true, entries: [{ path: 'src/deleted.bin', kind: 'deleted', code: ' D' }] }); const applied = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.strictEqual(applied.ok, true);
  fs.mkdirSync(path.join(f.code, 'src')); const target = path.join(f.code, 'src', 'deleted.bin'); fs.writeFileSync(target, Buffer.from('reappeared'));
  const preview = recovery.restore(f.cwd, f.id); assert.deepStrictEqual(preview.presence_conflicts, ['src/deleted.bin']); assert.strictEqual(preview.ok, false);
  const restored = recovery.restore(f.cwd, f.id, { apply: true, confirmWorkspaceQuiescent: true }); assert.deepStrictEqual(restored.presence_conflicts, ['src/deleted.bin']); assert.strictEqual(restored.ok, false); assert.strictEqual(fs.readFileSync(target, 'utf8'), 'reappeared');
});

test('apply exige workspace quiescent em recovery e restore', () => {
  const f = fixture('T-quiescent'); const refused = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, confirmWorkspaceQuiescent: false }); assert.strictEqual(refused.reason, 'workspace-quiescent-attestation-required');
  assert.strictEqual(recovery.restore(f.cwd, f.id, { apply: true }).reason, 'workspace-quiescent-attestation-required');
});

test('recovery reutiliza matching/kinds canônicos e ignora ignored', () => {
  const f = fixture('T-canonical-scope'); const claim = runs.get(f.cwd, f.id).write_claim; runs.update(f.cwd, f.id, { write_claim: { ...claim, paths: ['src/*.js', 'deep/**'] } });
  const status = () => ({ ok: true, entries: [
    { path: 'src/a.js', kind: 'modified', code: ' M' },
    { path: 'src/deeper/a.js', kind: 'modified', code: ' M' },
    { path: 'deep/x/y.txt', kind: 'untracked', code: '??' },
    { path: 'src/secret.js', kind: 'ignored', code: '!!' },
  ] });
  const out = recovery.inspect(f.cwd, f.id, { ...f.common, workingStatus: status }); assert.deepStrictEqual(out.dirty.map(e => e.path), ['src/a.js', 'deep/x/y.txt']);
});

test('criação fsynca parents novos bottom-up e indisponibilidade aborta named', () => {
  const f = fixture('T-dir-durable'); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('x')); const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }); const synced = [];
  const out = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty, io: { fsyncDir: dir => synced.push(path.resolve(dir)) } }); assert.strictEqual(out.ok, true);
  const attempt = path.resolve(f.cwd, out.bundle); const expected = [attempt, path.dirname(attempt), path.dirname(path.dirname(attempt)), path.dirname(path.dirname(path.dirname(attempt))), path.dirname(path.dirname(path.dirname(path.dirname(attempt))))];
  let cursor = -1; for (const dir of expected) { const next = synced.findIndex((value, index) => index > cursor && value === dir); assert(next > cursor, `fsync bottom-up ausente: ${dir}\n${synced.join('\n')}`); cursor = next; }

  const g = fixture('T-dir-unavailable'); const unavailable = new Error('unsupported'); unavailable.code = 'EPERM'; const refused = recovery.apply(g.cwd, g.id, { ...g.common, confirmOwnerStopped: true, io: { fsyncDir: () => { throw unavailable; } } }); assert.strictEqual(refused.reason, 'directory-fsync-unavailable:EPERM'); assert.strictEqual(runs.get(g.cwd, g.id).active, true);
});

test('estratégia de durabilidade é explícita em win32 e POSIX', () => {
  assert.strictEqual(recovery.durabilityStrategy({ platform: 'win32' }), 'file-fsync+atomic-file-publish+no-portable-dir-fsync'); assert.strictEqual(recovery.durabilityStrategy({ platform: 'linux' }), 'file-fsync+atomic-file-publish+posix-dir-fsync'); assert.deepStrictEqual(recovery.durabilityLimitations({ platform: 'win32' }), ['journal-file-fsync-only', 'directory-entry-durability-not-portable']);
  const f = fixture('T-platform-strategy'); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('x')); const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }); const { io, ...withoutIo } = f.common;
  const applied = recovery.apply(f.cwd, f.id, { ...withoutIo, confirmOwnerStopped: true, workingStatus: dirty }); assert.strictEqual(applied.ok, true, JSON.stringify(applied)); const manifest = JSON.parse(fs.readFileSync(path.join(f.cwd, applied.bundle, 'manifest.json'))); const strategy = process.platform === 'win32' ? 'file-fsync+atomic-file-publish+no-portable-dir-fsync' : 'file-fsync+atomic-file-publish+posix-dir-fsync'; assert.strictEqual(manifest.durability_strategy, strategy); assert.strictEqual(runs.get(f.cwd, f.id).write_claim.released.evidence.durability_strategy, strategy); assert.strictEqual(events(f.cwd)[0].evidence.durability_strategy, strategy); if (process.platform === 'win32') assert(manifest.durability_limitations.includes('directory-entry-durability-not-portable'));
});

test('payload manifest e sidecar são publicados atomicamente antes do CAS', () => {
  const f = fixture('T-pre-cas-publish'); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('x')); const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }); let links = 0; const actual = require('./forge-write-claim.js').recoverClaim;
  const io = { fsyncDir: () => {}, linkSync: (from, to) => { links++; return fs.linkSync(from, to); } }; const guardedCas = (...args) => { assert(links >= 3, `CAS antes das publicações atômicas: ${links}`); return actual(...args); };
  const out = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty, io, recoverClaim: guardedCas }); assert.strictEqual(out.ok, true); assert(links >= 3);
});

test('glob **/ captura dirty diretamente sob diretório', () => {
  const f = fixture('T-glob-zero-segment'); const claim = runs.get(f.cwd, f.id).write_claim; runs.update(f.cwd, f.id, { write_claim: { ...claim, paths: ['src/**/*.js'] } }); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.js'), Buffer.from('direct'));
  const dirty = () => ({ ok: true, entries: [{ path: 'src/a.js', kind: 'modified', code: ' M' }] }); const out = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.strictEqual(out.ok, true); const manifest = JSON.parse(fs.readFileSync(path.join(f.cwd, out.bundle, 'manifest.json'))); assert.deepStrictEqual(manifest.entries.map(e => e.path), ['src/a.js']);
});

for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
if (!process.exitCode) process.stdout.write(`\n${passed} passed, 0 failed\n`);
