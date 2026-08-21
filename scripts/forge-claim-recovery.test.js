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

for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
if (!process.exitCode) process.stdout.write(`\n${passed} passed, 0 failed\n`);
