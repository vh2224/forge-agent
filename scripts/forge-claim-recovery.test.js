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
  const common = { findStuckClaims: () => ({ stuck: [{ id }] }), workingStatus: () => ({ ok: true, vcs: 'git', entries: [] }) };
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
  assert.strictEqual(recovery.apply(f.cwd, f.id, opts).ok, true); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('new'));
  assert.deepStrictEqual(recovery.restore(f.cwd, f.id).conflicts, ['src/a.bin']); const applied = recovery.restore(f.cwd, f.id, { apply: true }); assert.strictEqual(applied.restored, true);
  assert.strictEqual(fs.readFileSync(path.join(f.code, 'src', 'a.bin'), 'utf8'), 'new'); const conflict = path.join(f.cwd, '.gsd', 'forge', 'claim-recovery', encodeURIComponent(f.id), 'conflicts', 'src', 'a.bin'); assert.strictEqual(fs.readFileSync(conflict, 'utf8'), 'old');
  assert.strictEqual(recovery.restore(f.cwd, f.id, { apply: true }).restored, true);
});
test('payload corrompido e containment falham fechado', () => {
  const f = fixture(); fs.mkdirSync(path.join(f.code, 'src')); fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('old'));
  const opts = { ...f.common, confirmOwnerStopped: true, workingStatus: () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }) };
  const applied = recovery.apply(f.cwd, f.id, opts); const root = path.join(f.cwd, applied.bundle); const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))); fs.writeFileSync(path.join(root, manifest.entries[0].payload), Buffer.from('bad'));
  assert.match(recovery.restore(f.cwd, f.id, { apply: true }).reason, /payload-corrupt/);
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
  const restoreResult = recovery.restore(restored.cwd, restored.id, { apply: true }); assert.match(restoreResult.reason, /manifest-path-reparse/); assert.strictEqual(fs.readFileSync(path.join(outside, 'a.bin'), 'utf8'), 'outside');
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
  const dirty = () => ({ ok: true, entries: [{ path: 'src/a.bin', kind: 'modified', code: ' M' }] }); assert.strictEqual(recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty }).ok, true);
  fs.writeFileSync(path.join(f.code, 'src', 'a.bin'), Buffer.from('current')); assert.strictEqual(recovery.restore(f.cwd, f.id, { apply: true }).restored, true);
  const conflict = path.join(f.cwd, '.gsd', 'forge', 'claim-recovery', encodeURIComponent(f.id), 'conflicts', 'src', 'a.bin'); fs.writeFileSync(conflict, Buffer.from('operator'));
  const result = recovery.restore(f.cwd, f.id, { apply: true }); assert.match(result.reason, /conflict-existing-divergent/); assert.strictEqual(fs.readFileSync(conflict, 'utf8'), 'operator');
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-exclusive-')); roots.push(root); const target = path.join(root, 'nested', 'file.bin'); const originalOpen = fs.openSync; let injected = false;
  fs.openSync = function(file, flags, ...rest) { if (!injected && path.resolve(file) === path.resolve(target) && flags === 'wx') { injected = true; fs.writeFileSync(target, Buffer.from('racer')); } return originalOpen.call(fs, file, flags, ...rest); };
  try { assert.throws(() => recovery.writeExclusive(root, target, Buffer.from('payload'), 'restore'), /restore-existing-divergent/); }
  finally { fs.openSync = originalOpen; }
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'racer');
});

test('dangling symlink é presença insegura, nunca ausência', () => {
  const f = fixture('T-dangling'); fs.mkdirSync(path.join(f.code, 'src')); const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dangling-target-')); roots.push(targetDir); const link = path.join(f.code, 'src', 'link'); fs.symlinkSync(targetDir, link, process.platform === 'win32' ? 'junction' : 'dir'); fs.rmSync(targetDir, { recursive: true, force: true }); const dirty = () => ({ ok: true, entries: [{ path: 'src/link/a.bin', kind: 'modified', code: ' M' }] });
  const capture = recovery.apply(f.cwd, f.id, { ...f.common, confirmOwnerStopped: true, workingStatus: dirty }); assert.match(capture.reason, /dirty-path-reparse/); assert.strictEqual(runs.get(f.cwd, f.id).active, true);
});

for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
if (!process.exitCode) process.stdout.write(`\n${passed} passed, 0 failed\n`);
