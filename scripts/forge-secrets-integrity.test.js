#!/usr/bin/env node
'use strict';

// All credentials are fictional and all stores live under this suite's temp dir.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ENGINE = path.join(__dirname, 'forge-secrets.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-secrets-integrity-'));
const originalEnv = process.env.FORGE_SECRETS_REGISTRY;
const originalSwitch = process.env.FORGE_KEYCHAIN_DISABLED;
process.env.FORGE_KEYCHAIN_DISABLED = '1';
let passed = 0;

function fixture() {
  const registry = path.join(fs.mkdtempSync(path.join(ROOT, 'case-')), 'registry.json');
  process.env.FORGE_SECRETS_REGISTRY = registry;
  delete require.cache[require.resolve(ENGINE)];
  const vault = require(ENGINE);
  vault.add({ service: 'example', name: 'original', secret: 'fictional-original' });
  return { vault, registry, fallback: `${registry}.secrets`, pending: `${registry}.pending` };
}

function child(f, source) {
  return spawnSync(process.execPath, ['-e', source, ENGINE], {
    encoding: 'utf8', timeout: 10000,
    env: { ...process.env, FORGE_SECRETS_REGISTRY: f.registry, FORGE_KEYCHAIN_DISABLED: '1' },
  });
}

function snapshot(f) { return [f.registry, f.fallback].map(file => fs.readFileSync(file, 'utf8')); }

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

async function main() {
  await test('primary vault errors survive guard release failure with separate CLI diagnosis', () => {
    for (const cli of [false, true]) {
      const f = fixture();
      fs.writeFileSync(f.registry, '{ "fictional-private": broken');
      const result = child(f, `
        const assert = require('assert'), fs = require('fs'), path = require('path'), unlink = fs.unlinkSync;
        const target = path.join(process.env.FORGE_SECRETS_REGISTRY + '.guard', '.gsd', '.locks', 'vault', 'metadata.json');
        fs.unlinkSync = function(file, ...args) {
          if (file === target) throw Object.assign(new Error('fictional-private'), {code:'EACCES'});
          return unlink.call(fs, file, ...args);
        };
        if (${cli}) {
          process.argv = [process.execPath, process.argv[1], '--remove', 'example', 'original'];
          require('module').runMain();
        } else {
          assert.throws(() => require(process.argv[1]).save([]), error => {
            assert.strictEqual(error.code, 'VAULT_INVALID');
            assert.match(error.message, /invalid vault JSON/);
            assert.strictEqual(error.guard_release_failure.code, 'VAULT_GUARD_RELEASE_FAILED');
            assert.match(error.guard_release_failure.message, /--recover --confirm-stopped/);
            assert(!JSON.stringify(error).includes('fictional-private'));
            return true;
          });
        }
      `);
      assert.strictEqual(result.status, cli ? 1 : 0, result.stderr);
      if (cli) {
        assert.match(result.stderr, /invalid vault JSON/);
        assert.match(result.stderr, /VAULT_GUARD_RELEASE_FAILED/);
        assert.match(result.stderr, /--recover --confirm-stopped/);
        assert(!result.stderr.includes('fictional-private'));
      }
      assert.strictEqual(fs.existsSync(f.pending), false);
    }
  });

  await test('unavailable Keychain before intent differs from a genuinely pending removal', () => {
    const f = fixture();
    const entries = f.vault.load();
    entries[0].store = 'keychain';
    f.vault.save(entries);
    const before = snapshot(f);
    assert.throws(() => f.vault.remove('example', 'original'), error => {
      assert.strictEqual(error.code, 'VAULT_KEYCHAIN_UNAVAILABLE');
      assert.match(error.message, /Keychain.*retry/i);
      assert(!error.message.includes('--recover'));
      return true;
    });
    assert.deepStrictEqual(snapshot(f), before);
    assert.strictEqual(fs.existsSync(f.pending), false);
    assert.strictEqual(f.vault.recover(), false);
    const result = child(f, `process.argv = [process.execPath, process.argv[1], '--remove', 'example', 'original']; require('module').runMain();`);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /Keychain.*retry/i);
    assert(!result.stderr.includes('--recover'));
    fs.writeFileSync(f.pending, JSON.stringify({ version: 1, operation: 'remove', service: 'example', name: 'original', credentials: [], needsKeychain: true }));
    const pending = fs.readFileSync(f.pending);
    assert.throws(() => f.vault.remove('example', 'original'), { code: 'VAULT_RECOVERY_REQUIRED' });
    assert.throws(() => f.vault.recover(), { code: 'VAULT_RECOVERY_REQUIRED' });
    assert.deepStrictEqual(fs.readFileSync(f.pending), pending);
    assert.deepStrictEqual(snapshot(f), before);
  });

  await test('hard crash immediately after guard mkdir is explicitly recoverable without guessing owner liveness', () => {
    for (const cli of [false, true]) {
      const f = fixture(), before = snapshot(f);
      const dir = path.join(`${f.registry}.guard`, '.gsd', '.locks', 'vault');
      const result = child(f, `
        const fs = require('fs'), path = require('path'), mkdir = fs.mkdirSync;
        const target = path.join(process.env.FORGE_SECRETS_REGISTRY + '.guard', '.gsd', '.locks', 'vault');
        fs.mkdirSync = function(file, ...args) {
          const value = mkdir.call(fs, file, ...args);
          if (file === target) process.exit(73);
          return value;
        };
        require(process.argv[1]).add({service:'example',name:'new',secret:'fictional-new'});
      `);
      assert.strictEqual(result.status, 73, result.stderr);
      assert.deepStrictEqual(fs.readdirSync(dir), []);
      assert.deepStrictEqual(snapshot(f), before);
      for (const operation of [() => f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' }),
        () => f.vault.remove('example', 'original'), () => f.vault.setDefault('example', 'original'),
        () => f.vault.save(f.vault.load()), () => f.vault.recover()]) {
        assert.throws(operation, { code: 'VAULT_GUARD_INCOMPLETE' });
      }
      let evidence;
      if (cli) {
        const recovery = child(f, `process.argv = [process.execPath, process.argv[1], '--recover', '--confirm-stopped']; require('module').runMain();`);
        assert.strictEqual(recovery.status, 0, recovery.stderr);
        assert(!recovery.stdout.includes('fictional-'));
        evidence = recovery.stdout.match(/Guard evidence preserved: (.+)/)[1].trim();
      } else evidence = f.vault.recover({ confirmStopped: true }).guard_evidence;
      assert.deepStrictEqual(fs.readdirSync(evidence), []);
      assert.deepStrictEqual(snapshot(f), before);
      f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' });
      assert.strictEqual(f.vault.get('example', 'new'), 'fictional-new');
    }
  });

  await test('partial guard release reports failure and explicit recovery preserves owner evidence', () => {
    for (const phase of ['metadata', 'released-marker', 'directory']) {
      const f = fixture(), unlink = fs.unlinkSync, rmdir = fs.rmdirSync;
      const dir = path.join(`${f.registry}.guard`, '.gsd', '.locks', 'vault');
      try {
        fs.unlinkSync = function(file, ...args) {
          if (phase === 'metadata' && file === path.join(dir, 'metadata.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
          return unlink.call(fs, file, ...args);
        };
        fs.rmdirSync = function(file, ...args) {
          if ((phase === 'directory' && file === dir) || (phase === 'released-marker' && path.dirname(file) === dir && file.endsWith('.released'))) {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
          return rmdir.call(fs, file, ...args);
        };
        assert.throws(() => f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' }), { code: 'VAULT_GUARD_RELEASE_FAILED' });
      } finally { fs.unlinkSync = unlink; fs.rmdirSync = rmdir; }
      const residue = fs.readdirSync(dir);
      const recovery = f.vault.recover({ confirmStopped: true });
      assert.deepStrictEqual(fs.readdirSync(recovery.guard_evidence), residue);
      assert.strictEqual(f.vault.get('example', 'new'), 'fictional-new', 'committed credential is not rolled back or lost');
      f.vault.add({ service: 'example', name: 'next', secret: 'fictional-next' });
      assert.strictEqual(f.vault.get('example', 'next'), 'fictional-next');
    }
  });

  await test('read failures preserve both stores for add/remove/default/save', () => {
    for (const target of ['registry', 'fallback']) {
      for (const operation of ['add', 'remove', 'default', 'save']) {
        if (target === 'fallback' && ['default', 'save'].includes(operation)) continue;
        const f = fixture(), before = snapshot(f), read = fs.readFileSync;
        const credentials = f.vault.load();
        try {
          fs.readFileSync = function (file, ...args) {
            if (file === f[target]) throw Object.assign(new Error('fictional-original'), { code: 'EACCES' });
            return read.call(fs, file, ...args);
          };
          assert.throws(() => {
            if (operation === 'add') f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' });
            if (operation === 'remove') f.vault.remove('example', 'original');
            if (operation === 'default') f.vault.setDefault('example', 'original');
            if (operation === 'save') f.vault.save(credentials);
          }, error => error.code === 'VAULT_UNREADABLE' && !error.message.includes('fictional-original'));
        } finally { fs.readFileSync = read; }
        assert.deepStrictEqual(snapshot(f), before);
        assert.strictEqual(fs.existsSync(f.pending), false);
      }
    }
  });

  await test('corrupt JSON and incompatible schemas never become an empty vault', () => {
    for (const target of ['registry', 'fallback']) {
      const invalid = ['{ "fictional-private": broken', 'null', '[]', '42'];
      if (target === 'registry') invalid.push('{}', '{"version":2,"credentials":[]}', '{"version":1,"credentials":[null]}');
      else invalid.push('{"forge-secret-example-original":42}');
      for (const raw of invalid) {
        const f = fixture();
        fs.writeFileSync(f[target], raw);
        const before = snapshot(f);
        for (const operation of [() => f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' }),
          () => f.vault.remove('example', 'original')]) {
          assert.throws(operation, error => error.code === 'VAULT_INVALID' && !error.message.includes('fictional-private'));
          assert.deepStrictEqual(snapshot(f), before);
        }
      }
    }
  });

  await test('short temporary write leaves old bytes intact and operation resumable', () => {
    const f = fixture(), before = snapshot(f);
    const open = fs.openSync, write = fs.writeFileSync;
    let targetFd;
    try {
      fs.openSync = function (file, ...args) {
        const fd = open.call(fs, file, ...args);
        if (String(file).startsWith(`${f.fallback}.`)) targetFd = fd;
        return fd;
      };
      fs.writeFileSync = function (file, data, ...args) {
        if (file === targetFd) {
          fs.writeSync(file, String(data).slice(0, 12));
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return write.call(fs, file, data, ...args);
      };
      assert.throws(() => f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' }), { code: 'ENOSPC' });
    } finally { fs.openSync = open; fs.writeFileSync = write; }
    assert.deepStrictEqual(snapshot(f), before);
    assert(fs.existsSync(f.pending));
    assert(!fs.readdirSync(path.dirname(f.registry)).some(file => file.endsWith('.tmp')));
    assert.throws(() => f.vault.recover(), { code: 'VAULT_RECOVERY_REQUIRED' });
    f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' });
    assert.strictEqual(f.vault.get('example', 'original'), 'fictional-original');
    assert.strictEqual(f.vault.get('example', 'new'), 'fictional-new');
  });

  await test('failed metadata publication blocks unrelated writes and recovers explicitly', () => {
    const f = fixture(), before = snapshot(f), rename = fs.renameSync;
    try {
      fs.renameSync = function (from, to) {
        if (to === f.registry) throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
        return rename.call(fs, from, to);
      };
      assert.throws(() => f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' }), { code: 'EACCES' });
    } finally { fs.renameSync = rename; }
    assert.strictEqual(snapshot(f)[0], before[0]);
    assert(!fs.readFileSync(f.pending, 'utf8').includes('fictional-new'));
    assert.throws(() => f.vault.load(), { code: 'VAULT_RECOVERY_REQUIRED' });
    assert.throws(() => f.vault.setDefault('example', 'original'), { code: 'VAULT_RECOVERY_REQUIRED' });
    assert.throws(() => f.vault.add({ service: 'example', name: 'other', secret: 'fictional-other' }), { code: 'VAULT_RECOVERY_REQUIRED' });
    assert.strictEqual(f.vault.secretState('example', 'new'), 'unknown');
    assert.strictEqual(f.vault.recover(), true);
    assert.strictEqual(f.vault.recover(), false);
    assert.strictEqual(f.vault.get('example', 'new'), 'fictional-new');
    assert.strictEqual(f.vault.load().length, 2);
  });

  await test('remove failure retains intent and recovery completes metadata deletion', () => {
    const f = fixture(), rename = fs.renameSync;
    try {
      fs.renameSync = function (from, to) {
        if (to === f.registry) throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
        return rename.call(fs, from, to);
      };
      assert.throws(() => f.vault.remove('example', 'original'), { code: 'EACCES' });
    } finally { fs.renameSync = rename; }
    assert.strictEqual(f.vault.recover(), true);
    assert.deepStrictEqual(f.vault.load(), []);
    assert.strictEqual(f.vault.get('example', 'original'), null);
  });

  await test('simulated Keychain recovery never journals secret bytes and deletion failures are explicit', () => {
    const f = fixture(), cp = require('child_process'), keySwitch = require('./forge-keychain-switch');
    const exec = cp.execFileSync, enabled = keySwitch.keychainEnabled, rename = fs.renameSync;
    const values = new Map();
    let failDelete = true;
    try {
      keySwitch.keychainEnabled = () => true;
      cp.execFileSync = (command, args) => {
        assert.strictEqual(command, 'security');
        const key = args[args.indexOf('-s') + 1];
        if (args[0] === 'add-generic-password') { values.set(key, args[args.indexOf('-w') + 1]); return ''; }
        if (args[0] === 'delete-generic-password' && failDelete) throw Object.assign(new Error('locked'), { status: 36 });
        if (!values.has(key)) throw Object.assign(new Error('missing'), { status: 44 });
        if (args[0] === 'delete-generic-password') { values.delete(key); return ''; }
        return `${values.get(key)}\n`;
      };
      delete require.cache[require.resolve(ENGINE)];
      const vault = require(ENGINE);
      fs.renameSync = function (from, to) {
        if (to === f.registry) throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
        return rename.call(fs, from, to);
      };
      assert.throws(() => vault.add({ service: 'example', name: 'keychain', secret: 'fictional-keychain' }), { code: 'EACCES' });
      fs.renameSync = rename;
      for (const file of [f.pending, f.registry, f.fallback]) assert(!fs.readFileSync(file, 'utf8').includes('fictional-keychain'));
      assert.strictEqual(vault.recover(), true);
      assert.strictEqual(vault.find('example', 'keychain').store, 'keychain');
      const before = snapshot(f);
      assert.throws(() => vault.remove('example', 'keychain'), { code: 'VAULT_UNREADABLE' });
      assert.deepStrictEqual(snapshot(f), before);
      assert.throws(() => vault.recover(), { code: 'VAULT_RECOVERY_REQUIRED' });
      failDelete = false;
      assert.strictEqual(vault.remove('example', 'keychain'), true);
      assert.strictEqual(vault.find('example', 'keychain'), null);
    } finally {
      cp.execFileSync = exec; keySwitch.keychainEnabled = enabled; fs.renameSync = rename;
      delete require.cache[require.resolve(ENGINE)];
    }
  });

  await test('process interruption before/after rename never truncates published files', () => {
    for (const after of [false, true]) {
      const f = fixture(), before = snapshot(f);
      const r = child(f, `
        const fs = require('fs'), rename = fs.renameSync;
        fs.renameSync = function(from, to) {
          if (to === process.env.FORGE_SECRETS_REGISTRY + '.secrets') {
            if (${after}) rename.call(fs, from, to);
            process.exit(73);
          }
          return rename.call(fs, from, to);
        };
        require(process.argv[1]).add({service:'example',name:'new',secret:'fictional-new'});
      `);
      assert.strictEqual(r.status, 73, r.stderr);
      assert.strictEqual(snapshot(f)[0], before[0]);
      assert.strictEqual(JSON.parse(snapshot(f)[1])['forge-secret-example-original'], 'fictional-original');
      if (!after) {
        assert.strictEqual(snapshot(f)[1], before[1]);
        f.vault.add({ service: 'example', name: 'new', secret: 'fictional-new' });
      } else {
        const recovered = child(f, `process.argv = [process.execPath, process.argv[1], '--recover']; require('module').runMain();`);
        assert.strictEqual(recovered.status, 0, recovered.stderr);
        assert(!recovered.stdout.includes('fictional-'));
      }
      assert.strictEqual(f.vault.get('example', 'new'), 'fictional-new');
      assert.strictEqual(f.vault.get('example', 'original'), 'fictional-original');
      assert.strictEqual(fs.existsSync(f.pending), false);
    }
  });

  await test('two overlapping process additions survive the entire read/modify/write cycle', async () => {
    const f = fixture(), started = path.join(path.dirname(f.registry), 'second-started');
    const launch = source => spawn(process.execPath, ['-e', source, ENGINE], {
      env: { ...process.env, FORGE_SECRETS_REGISTRY: f.registry, SECOND_STARTED: started, FORGE_KEYCHAIN_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const first = launch(`
      const fs = require('fs'), read = fs.readFileSync;
      let waited = false;
      fs.readFileSync = function(file, ...args) {
        const result = read.call(fs, file, ...args);
        if (file === process.env.FORGE_SECRETS_REGISTRY && !waited) {
          waited = true; process.stdout.write('ready');
          const until = Date.now() + 5000, sleeper = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(process.env.SECOND_STARTED) && Date.now() < until) Atomics.wait(sleeper, 0, 0, 10);
          Atomics.wait(sleeper, 0, 0, 250);
        }
        return result;
      };
      require(process.argv[1]).add({service:'example',name:'first',secret:'fictional-first'});
    `);
    let second;
    const completion = proc => new Promise((resolve, reject) => {
      let stderr = '';
      proc.stderr.on('data', data => { stderr += data; });
      proc.on('error', reject);
      proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`)));
    });
    const doneFirst = completion(first);
    const timeout = setTimeout(() => { first.kill(); if (second) second.kill(); }, 10000);
    try {
      await new Promise((resolve, reject) => {
        first.stdout.once('data', resolve);
        first.once('error', reject);
        first.once('exit', () => reject(new Error('first process exited before barrier')));
      });
      second = launch(`
        require('fs').writeFileSync(process.env.SECOND_STARTED, 'started');
        require(process.argv[1]).add({service:'example',name:'second',secret:'fictional-second'});
      `);
      await Promise.all([doneFirst, completion(second)]);
    } finally { clearTimeout(timeout); first.kill(); if (second) second.kill(); }
    assert.strictEqual(f.vault.load().length, 3);
    for (const name of ['original', 'first', 'second']) assert.strictEqual(f.vault.get('example', name), `fictional-${name}`);
  });

  await test('fresh registry/fallback still initialize with owner-only file permissions', () => {
    const f = fixture();
    if (process.platform !== 'win32') {
      for (const file of [f.registry, f.fallback]) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.strictEqual(f.vault.load().length, 1);
  });
  console.log(`${passed} integrity tests passed`);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  if (originalEnv === undefined) delete process.env.FORGE_SECRETS_REGISTRY;
  else process.env.FORGE_SECRETS_REGISTRY = originalEnv;
  if (originalSwitch === undefined) delete process.env.FORGE_KEYCHAIN_DISABLED;
  else process.env.FORGE_KEYCHAIN_DISABLED = originalSwitch;
  fs.rmSync(ROOT, { recursive: true, force: true });
});
