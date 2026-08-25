'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bundle = require('./forge-svn-evidence-bundle');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-svn-bundle-')); }
function runner(file, argv) {
  return { status: 0, signal: null, error: null,
    stdout: Buffer.from(`${file} ${argv.join(' ')}\n`, 'utf8'), stderr: Buffer.alloc(0) };
}
function captured() {
  const root = temp(), cwd = path.join(root, 'wc'), out = path.join(root, 'raw');
  fs.mkdirSync(cwd);
  bundle.capture({ cwd, output: out, runner, now: () => '2026-08-24T00:00:00.000Z', platform: 'fixture' });
  return { root, cwd, out };
}
function mutate(source, callback) {
  const target = `${source}-mutated`;
  fs.cpSync(source, target, { recursive: true }); callback(target); return target;
}

test('capture, sanitize and verify use the same contract', () => {
  const x = captured();
  try {
    assert.strictEqual(bundle.verify(x.out).mode, 'raw');
    const safe = path.join(x.root, 'safe');
    bundle.sanitize({ input: x.out, output: safe });
    const result = bundle.verify(safe);
    assert.strictEqual(result.mode, 'sanitized');
    assert.strictEqual(result.cwd, bundle.SANITIZED_CWD);
    assert(!fs.readFileSync(path.join(safe, 'manifest.json'), 'utf8').includes(x.cwd));
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});
test('capture refuses output inside target and preexisting output', () => {
  const root = temp(), cwd = path.join(root, 'wc'); fs.mkdirSync(cwd);
  try {
    assert.throws(() => bundle.capture({ cwd, output: path.join(cwd, 'bundle'), runner }), /outside_target/);
    const out = path.join(root, 'exists'); fs.mkdirSync(out);
    assert.throws(() => bundle.capture({ cwd, output: out, runner }), /must_not_exist/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('rejects stdout and stderr tampering', () => {
  const x = captured();
  try {
    for (const suffix of ['stdout.bin', 'stderr.bin']) {
      const bad = mutate(x.out, dir => fs.appendFileSync(path.join(dir, 'commands', '00', suffix), 'x'));
      assert.throws(() => bundle.verify(bad), /hash_mismatch|length_mismatch/); fs.rmSync(bad, { recursive: true });
    }
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});
test('rejects missing and extra files', () => {
  const x = captured();
  try {
    let bad = mutate(x.out, dir => fs.unlinkSync(path.join(dir, 'commands', '00', 'stdout.bin')));
    assert.throws(() => bundle.verify(bad), /inventory_mismatch/); fs.rmSync(bad, { recursive: true });
    bad = mutate(x.out, dir => fs.writeFileSync(path.join(dir, 'extra'), 'x'));
    assert.throws(() => bundle.verify(bad), /inventory_mismatch/);
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});
test('rejects seal, cwd, path, encoding and argv changes', () => {
  const x = captured();
  try {
    for (const edit of [
      m => { m.seal = '0'.repeat(64); }, m => { m.cwd = 'relative'; },
      m => { m.inventory[0].path = '../escape'; }, m => { m.commands[0].stdout.encoding = 'latin1'; },
      m => { m.commands[0].argv = ['status', '-u', '.']; }
    ]) {
      const bad = mutate(x.out, dir => { const p = path.join(dir, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p)); edit(m); fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n'); });
      assert.throws(() => bundle.verify(bad)); fs.rmSync(bad, { recursive: true });
    }
  } finally { fs.rmSync(x.root, { recursive: true, force: true }); }
});
test('invalid UTF-8 is declared binary and survives round-trip', () => {
  const x = temp(), cwd = path.join(x, 'wc'), out = path.join(x, 'raw'); fs.mkdirSync(cwd);
  try {
    bundle.capture({ cwd, output: out, runner: () => ({ status: 0, signal: null, error: null, stdout: Buffer.from([0xff]), stderr: Buffer.alloc(0) }) });
    const m = bundle.verify(out); assert.strictEqual(m.commands[0].stdout.encoding, 'binary');
  } finally { fs.rmSync(x, { recursive: true, force: true }); }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); process.stdout.write(`ok - ${name}\n`); }
  catch (error) { failed++; process.stderr.write(`not ok - ${name}\n${error.stack}\n`); }
}
if (failed) process.exitCode = 1;
