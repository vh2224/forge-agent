'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const provider = require('./forge-update-check');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-security-'));
let passed = 0, skipped = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
function skip(name) { skipped++; console.log(`SKIP ${name}`); }
function fixture(name) {
  const cacheDir = path.join(root, name); fs.mkdirSync(cacheDir, { mode: 0o700 });
  const repo = path.join(root, 'nonexistent-repository');
  return { repo, cacheDir, file: provider.cachePath(repo, cacheDir) };
}
function render(f) { return provider.cachedUpdate(f.repo, { cacheDir: f.cacheDir, spawn() { return { on() {}, unref() {} }; } }); }
function unknown(value) {
  assert.strictEqual(value.state, 'unknown'); assert.strictEqual(value.has_update, false);
  assert.strictEqual(value.version, ''); assert.strictEqual(value.remote_version, '');
}
const valid = () => ({ ts: Date.now(), state: 'behind', version: 'v1.0.0', has_update: true, remote_version: 'v2.0.0', generation: null });

try {
  test('malformed and terminal-control cache payloads cannot reach the renderer', () => {
    const f = fixture('schema');
    const malformed = ['{', 'null', '[]', JSON.stringify({ ...valid(), ts: 'fresh' }),
      JSON.stringify({ ...valid(), state: 'invented' }), JSON.stringify({ ...valid(), has_update: 'true' }),
      JSON.stringify({ ...valid(), version: 'x'.repeat(257) }), JSON.stringify({ ...valid(), remote_version: {} })];
    for (const field of ['version', 'remote_version']) {
      for (const text of ['\x1b]52;c;ZXhwbG9pdA==\x07', 'v2\nforged line', 'v2\rreplace', 'v2\x9b31m', 'v2\0hidden']) {
        malformed.push(JSON.stringify({ ...valid(), [field]: text }));
      }
    }
    for (const text of malformed) { fs.writeFileSync(f.file, text, { mode: 0o600 }); unknown(render(f)); }
    fs.writeFileSync(f.file, JSON.stringify(valid()), { mode: 0o600 });
    assert.strictEqual(render(f).has_update, true, 'valid payload remains usable');
  });

  test('oversized cache and invalid generation fail closed', () => {
    const f = fixture('bounded');
    fs.writeFileSync(f.file, JSON.stringify({ ...valid(), padding: 'x'.repeat(65536) }), { mode: 0o600 }); unknown(render(f));
    fs.writeFileSync(f.file, JSON.stringify(valid()));
    fs.writeFileSync(`${f.file}.generation`, '\x1b]52;c;ZXhwbG9pdA==\x07', { mode: 0o600 }); unknown(render(f));
  });

  test('refresh and invalidation publish unpredictable exclusive 0600 staging files', () => {
    const f = fixture('publication'), open = fs.openSync, staging = [];
    try {
      fs.openSync = (file, flags, mode) => {
        if (typeof file === 'string' && file.startsWith(f.cacheDir) && file.endsWith('.tmp')) {
          staging.push(file); assert.strictEqual(flags, 'wx'); assert.strictEqual(mode, 0o600);
          assert(!file.endsWith(`.${process.pid}.tmp`), 'PID-only staging name is predictable');
        }
        return open.call(fs, file, flags, mode);
      };
      provider.refresh(f.repo, { cacheDir: f.cacheDir });
      provider.refresh(f.repo, { cacheDir: f.cacheDir });
      provider.invalidateCache(f.repo, { cacheDir: f.cacheDir });
    } finally { fs.openSync = open; }
    assert.strictEqual(staging.length, 3); assert.strictEqual(new Set(staging).size, 3);
    assert(staging.every(file => !fs.existsSync(file)), 'owned staging files are cleaned after publication');
  });

  for (const method of ['refresh', 'invalidateCache']) {
    test(`${method} preserves a pre-existing staging collision`, () => {
      const f = fixture(`collision-${method}`), uuid = crypto.randomUUID, token = '11111111-1111-4111-8111-111111111111';
      const collision = `${f.file}${method === 'invalidateCache' ? '.generation' : ''}.${token}.tmp`;
      const sentinel = Buffer.from('unowned collision must survive'); fs.writeFileSync(collision, sentinel, { mode: 0o600 });
      try {
        crypto.randomUUID = () => token;
        assert.throws(() => provider[method](f.repo, { cacheDir: f.cacheDir }), { code: 'EEXIST' });
      } finally { crypto.randomUUID = uuid; }
      assert.deepStrictEqual(fs.readFileSync(collision), sentinel);
    });
  }

  test('a linked private cache directory is refused without touching its target', () => {
    const f = fixture('link-target'), link = path.join(root, 'linked-cache');
    fs.writeFileSync(path.join(f.cacheDir, 'sentinel'), 'keep');
    fs.symlinkSync(f.cacheDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    const before = fs.readdirSync(f.cacheDir);
    let launches = 0;
    unknown(provider.cachedUpdate(f.repo, { cacheDir: link, spawn() { launches++; throw new Error('unsafe launch'); } }));
    assert.strictEqual(launches, 0);
    for (const method of ['refresh', 'invalidateCache']) assert.throws(() => provider[method](f.repo, { cacheDir: link }), /Unsafe update cache directory/);
    assert.deepStrictEqual(fs.readdirSync(f.cacheDir), before); assert.strictEqual(fs.readFileSync(path.join(f.cacheDir, 'sentinel'), 'utf8'), 'keep');
    const marker = `${provider.cachePath(f.repo, f.cacheDir)}.refresh`; fs.writeFileSync(marker, 'unowned refresh marker');
    const cli = spawnSync(process.execPath, [require.resolve('./forge-update-check'), '--refresh', f.repo, link], { encoding: 'utf8', timeout: 5000 });
    assert.notStrictEqual(cli.status, 0, 'CLI must report rejected cache directory');
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'unowned refresh marker', 'CLI finally must not follow rejected directory');
  });

  if (process.platform !== 'win32') {
    test('POSIX private directory and cache files have restrictive permissions', () => {
      const cacheDir = path.join(root, 'created-private'), repo = path.join(root, 'missing');
      provider.refresh(repo, { cacheDir }); const file = provider.cachePath(repo, cacheDir);
      assert.strictEqual(fs.statSync(cacheDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      provider.invalidateCache(repo, { cacheDir }); assert.strictEqual(fs.statSync(`${file}.generation`).mode & 0o777, 0o600);
    });
    test('POSIX group/world-accessible directory is refused without mutation', () => {
      const f = fixture('unsafe-mode'); fs.chmodSync(f.cacheDir, 0o777);
      unknown(render(f));
      for (const method of ['refresh', 'invalidateCache']) assert.throws(() => provider[method](f.repo, { cacheDir: f.cacheDir }), /Unsafe update cache directory/);
      assert.deepStrictEqual(fs.readdirSync(f.cacheDir), []); assert.strictEqual(fs.statSync(f.cacheDir).mode & 0o777, 0o777);
    });
    test('POSIX foreign-owner directory and file metadata are refused', () => {
      const f = fixture('foreign-owner'); fs.writeFileSync(f.file, JSON.stringify(valid()), { mode: 0o600 });
      const lstat = fs.lstatSync;
      for (const target of [f.cacheDir, f.file]) {
        try {
          // Unprivileged CI cannot chown fixtures; vary only the measured UID.
          fs.lstatSync = (file, ...args) => {
            const stat = lstat.call(fs, file, ...args);
            if (file === target) stat.uid = process.getuid() + 1;
            return stat;
          };
          unknown(render(f));
          if (target === f.cacheDir) for (const method of ['refresh', 'invalidateCache']) assert.throws(() => provider[method](f.repo, { cacheDir: f.cacheDir }), /Unsafe update cache directory/);
        } finally { fs.lstatSync = lstat; }
      }
      assert.strictEqual(JSON.parse(fs.readFileSync(f.file)).remote_version, 'v2.0.0');
    });
  } else {
    for (const name of ['POSIX modes on publication', 'POSIX unsafe-directory mode', 'POSIX foreign-owner stat guard']) skip(name);
  }
  let fileSymlinks = true;
  const probeTarget = path.join(root, 'symlink-probe-target'), probeLink = path.join(root, 'symlink-probe-link');
  fs.writeFileSync(probeTarget, 'probe');
  try { fs.symlinkSync(probeTarget, probeLink, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    fileSymlinks = false;
  }
  if (fileSymlinks) {
    test('actual staging symlink collision never truncates victim or removes link', () => {
      for (const method of ['refresh', 'invalidateCache']) {
        const f = fixture(`symlink-${method}`), victim = path.join(root, `victim-${method}`), uuid = crypto.randomUUID;
        const token = '22222222-2222-4222-8222-222222222222', collision = `${f.file}${method === 'invalidateCache' ? '.generation' : ''}.${token}.tmp`;
        fs.writeFileSync(victim, 'keep victim'); fs.symlinkSync(victim, collision);
        try { crypto.randomUUID = () => token; assert.throws(() => provider[method](f.repo, { cacheDir: f.cacheDir }), { code: 'EEXIST' }); }
        finally { crypto.randomUUID = uuid; }
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep victim'); assert(fs.lstatSync(collision).isSymbolicLink());
      }
    });
    test('symlinked cache and generation files are not trusted', () => {
      for (const suffix of ['', '.generation']) {
        const f = fixture(`linked-file-${suffix || 'cache'}`), victim = path.join(root, `cache-victim-${suffix || 'cache'}`);
        fs.writeFileSync(victim, suffix ? '33333333-3333-4333-8333-333333333333' : JSON.stringify(valid()), { mode: 0o600 });
        if (suffix) fs.writeFileSync(f.file, JSON.stringify({ ...valid(), generation: fs.readFileSync(victim, 'utf8') }), { mode: 0o600 });
        const before = fs.readFileSync(victim); fs.symlinkSync(victim, f.file + suffix); unknown(render(f));
        assert.deepStrictEqual(fs.readFileSync(victim), before); assert(fs.lstatSync(f.file + suffix).isSymbolicLink());
      }
    });
  } else {
    for (const name of ['file-symlink staging collision (Windows symlink privilege unavailable)', 'cache/generation symlink reads (Windows symlink privilege unavailable)']) skip(name);
  }
  console.log(`forge-update security: ${passed} passed, ${skipped} platform skips`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
