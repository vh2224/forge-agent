'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const provider = require('./forge-update-check');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-update-security-'));
let passed = 0;
let skipped = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

function skip(name) {
  skipped++;
  console.log(`SKIP ${name}`);
}

function fixture(name) {
  const forgeHome = path.join(root, `${name}-home`);
  const cacheDir = path.join(root, `${name}-cache`);
  fs.mkdirSync(forgeHome, { recursive: true });
  fs.mkdirSync(cacheDir, { mode: 0o700 });
  const target = { forgeHome };
  return { forgeHome, cacheDir, target, file: provider.cachePath(target, cacheDir) };
}

function writeManifest(f, source, extras = {}) {
  fs.writeFileSync(path.join(f.forgeHome, 'manifest.json'), JSON.stringify({
    version: '1.2.3',
    source_remote: {
      remote: 'https://example.invalid/forge.git',
      channel: 'stable',
      tag: 'v1.2.3',
      sha: 'a'.repeat(40),
      ...source,
    },
    ...extras,
  }));
}

function unknown(value) {
  assert.strictEqual(value.state, 'unknown');
  assert.strictEqual(value.has_update, false);
  assert.strictEqual(value.version, '');
  assert.strictEqual(value.remote_version, '');
}

function validCache(overrides = {}) {
  return {
    schema_version: provider._private.CACHE_SCHEMA_VERSION,
    ts: Date.now(),
    state: 'behind',
    source_mode: 'remote',
    identity: 'b'.repeat(64),
    version: 'v1.2.3',
    has_update: true,
    remote_version: 'v2.0.0',
    generation: null,
    ...overrides,
  };
}

function render(f) {
  return provider.cachedUpdate(f.target, {
    cacheDir: f.cacheDir,
    spawn() { return { on() {}, unref() {} }; },
  });
}

try {
  test('remote beginning with an option is rejected before Git', () => {
    const f = fixture('leading-option');
    writeManifest(f, { remote: '--upload-pack=credential-stealer' });
    let calls = 0;
    const value = provider.refresh(f.target, {
      cacheDir: f.cacheDir,
      git() { calls++; throw new Error('Git must not run'); },
    });
    unknown(value);
    assert.strictEqual(calls, 0);
    assert(!fs.readFileSync(f.file, 'utf8').includes('credential-stealer'));
  });

  test('control characters in remote, tag, sha or channel never reach Git or cache', () => {
    for (const field of ['remote', 'tag', 'sha', 'channel']) {
      const f = fixture(`control-${field}`);
      const secret = `hostile-${field}\nAuthorization: bearer SECRET`;
      writeManifest(f, { [field]: secret });
      let calls = 0;
      const value = provider.refresh(f.target, {
        cacheDir: f.cacheDir,
        git() { calls++; throw new Error('Git must not run'); },
      });
      unknown(value);
      assert.strictEqual(calls, 0, field);
      const cache = fs.readFileSync(f.file, 'utf8');
      assert(!cache.includes('SECRET'), field);
      assert(!cache.includes(secret), field);
    }
  });

  test('excessive remote, tag, sha and channel fields are fail-closed', () => {
    for (const [field, size] of [['remote', 2049], ['tag', 65], ['sha', 65], ['channel', 17]]) {
      const f = fixture(`large-${field}`);
      writeManifest(f, { [field]: 'x'.repeat(size) });
      let calls = 0;
      unknown(provider.refresh(f.target, {
        cacheDir: f.cacheDir,
        git() { calls++; throw new Error('Git must not run'); },
      }));
      assert.strictEqual(calls, 0, field);
    }
  });

  test('unknown channel, invalid SHA and unstable tag are rejected before Git', () => {
    const cases = [
      ['channel', { channel: 'nightly' }],
      ['short-sha', { sha: 'abc123' }],
      ['upper-sha', { sha: 'A'.repeat(40) }],
      ['prerelease-tag', { tag: 'v1.2.3-rc.1' }],
      ['loose-tag', { tag: 'release-1.2.3' }],
      ['master-tag', { channel: 'master', tag: 'v1.2.3' }],
    ];
    for (const [name, source] of cases) {
      const f = fixture(`invalid-${name}`);
      writeManifest(f, source);
      let calls = 0;
      unknown(provider.refresh(f.target, {
        cacheDir: f.cacheDir,
        git() { calls++; throw new Error('Git must not run'); },
      }));
      assert.strictEqual(calls, 0, name);
    }
  });

  test('manifest larger than 64 KiB is rejected without parsing or Git', () => {
    const f = fixture('oversized-manifest');
    fs.writeFileSync(path.join(f.forgeHome, 'manifest.json'), JSON.stringify({ pad: 'x'.repeat(70000) }));
    let calls = 0;
    unknown(provider.refresh(f.target, {
      cacheDir: f.cacheDir,
      git() { calls++; throw new Error('Git must not run'); },
    }));
    assert.strictEqual(calls, 0);
    assert(fs.statSync(path.join(f.forgeHome, 'manifest.json')).size > provider._private.MAX_FILE_BYTES);
  });

  test('structured Git invocation receives a validated remote as a single argv item', () => {
    const f = fixture('structured-argv');
    const remote = 'https://example.invalid/path with spaces/forge.git';
    writeManifest(f, { remote });
    const calls = [];
    const value = provider.refresh(f.target, {
      cacheDir: f.cacheDir,
      git(cwd, args, options) {
        calls.push({ cwd, args, options });
        return `${'a'.repeat(40)}\trefs/tags/v1.2.3\n`;
      },
    });
    assert.strictEqual(value.state, 'equal');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].args, ['ls-remote', '--tags', remote]);
    assert.strictEqual(calls[0].args.filter((arg) => arg === remote).length, 1);
    const source = fs.readFileSync(require.resolve('./forge-update-check'), 'utf8');
    assert(!/\{\s*exec(?:Sync)?\s*\}\s*=\s*require\(['"]child_process['"]\)/.test(source));
    assert(!/child_process['"]\)\.exec(?:Sync)?\s*\(/.test(source));
    assert(!/shell\s*:\s*true/.test(source));
  });

  test('diagnostics and persisted cache never expose a credential-bearing remote', () => {
    const f = fixture('credential-redaction');
    const secretRemote = 'https://user:top-secret@example.invalid/forge.git';
    writeManifest(f, { remote: secretRemote });
    const value = provider.refresh(f.target, {
      cacheDir: f.cacheDir,
      git() { throw new Error(`Command failed: git ls-remote --tags ${secretRemote}`); },
    });
    unknown(value);
    assert.strictEqual(value.error, 'update-check-unavailable');
    assert(!JSON.stringify(value).includes(secretRemote));
    assert(!JSON.stringify(value).includes('top-secret'));
    assert(!fs.readFileSync(f.file, 'utf8').includes('top-secret'));
  });

  test('cache accepts differs but rejects legacy, unsafe text and invented states', () => {
    const f = fixture('cache-schema');
    fs.writeFileSync(f.file, JSON.stringify(validCache({ state: 'differs' })), { mode: 0o600 });
    const differs = render(f);
    assert.strictEqual(differs.state, 'differs');
    assert.strictEqual(differs.has_update, true);
    for (const payload of [
      { ...validCache(), schema_version: undefined },
      { ...validCache(), state: 'invented' },
      { ...validCache(), version: 'v1\nforged' },
      { ...validCache(), remote_version: '\x1b]52;c;ZXhwbG9pdA==\x07' },
      { ...validCache(), remote_version: 'x'.repeat(257) },
      { ...validCache(), identity: 'short' },
      { ...validCache(), source_mode: 'shell' },
    ]) {
      fs.rmSync(`${f.file}.refresh`, { force: true });
      fs.writeFileSync(f.file, JSON.stringify(payload), { mode: 0o600 });
      unknown(render(f));
    }
  });

  test('oversized cache is treated as absent and never rendered', () => {
    const f = fixture('oversized-cache');
    fs.writeFileSync(f.file, JSON.stringify({ ...validCache(), pad: 'x'.repeat(70000) }), { mode: 0o600 });
    unknown(render(f));
  });

  test('symlinked cache directory is refused without launch or mutation', () => {
    const f = fixture('linked-directory');
    const link = path.join(root, 'linked-cache');
    fs.writeFileSync(path.join(f.cacheDir, 'sentinel'), 'keep');
    fs.symlinkSync(f.cacheDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    let launches = 0;
    unknown(provider.cachedUpdate(f.target, {
      cacheDir: link,
      spawn() { launches++; throw new Error('must not launch'); },
    }));
    assert.strictEqual(launches, 0);
    assert.throws(() => provider.refresh(f.target, { cacheDir: link }), /Unsafe update cache directory/);
    assert.throws(() => provider.invalidateCache(f.target, { cacheDir: link }), /Unsafe update cache directory/);
    assert.strictEqual(fs.readFileSync(path.join(f.cacheDir, 'sentinel'), 'utf8'), 'keep');
  });

  if (process.platform !== 'win32') {
    test('cache publications retain private POSIX permissions', () => {
      const f = fixture('private-permissions');
      writeManifest(f, {});
      provider.refresh(f.target, {
        cacheDir: f.cacheDir,
        git() { return `${'a'.repeat(40)}\trefs/tags/v1.2.3\n`; },
      });
      assert.strictEqual(fs.statSync(f.cacheDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(f.file).mode & 0o777, 0o600);
      provider.invalidateCache(f.target, { cacheDir: f.cacheDir });
      assert.strictEqual(fs.statSync(`${f.file}.generation`).mode & 0o777, 0o600);
    });
  } else skip('POSIX permission checks');

  let fileSymlinks = true;
  const probeTarget = path.join(root, 'symlink-probe-target');
  const probeLink = path.join(root, 'symlink-probe-link');
  fs.writeFileSync(probeTarget, 'probe');
  try { fs.symlinkSync(probeTarget, probeLink, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'ENOTSUP'].includes(error.code)) throw error;
    fileSymlinks = false;
  }
  if (fileSymlinks) {
    test('exclusive staging publication never follows a symlink collision', () => {
      const f = fixture('staging-symlink');
      writeManifest(f, {});
      const victim = path.join(root, 'staging-victim');
      const token = '22222222-2222-4222-8222-222222222222';
      const collision = `${f.file}.${token}.tmp`;
      fs.writeFileSync(victim, 'keep victim');
      fs.symlinkSync(victim, collision);
      const original = crypto.randomUUID;
      try {
        crypto.randomUUID = () => token;
        assert.throws(() => provider.refresh(f.target, {
          cacheDir: f.cacheDir,
          git() { return `${'a'.repeat(40)}\trefs/tags/v1.2.3\n`; },
        }), { code: 'EEXIST' });
      } finally { crypto.randomUUID = original; }
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'keep victim');
      assert(fs.lstatSync(collision).isSymbolicLink());
    });
  } else skip('Windows file-symlink privilege unavailable');

  test('refresh CLI rejects malformed request without echoing its bytes', () => {
    const result = spawnSync(process.execPath, [require.resolve('./forge-update-check'), '--refresh', 'not-base64-json', root], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notStrictEqual(result.status, 0);
    assert(!result.stderr.includes('not-base64-json'));
  });

  console.log(`forge-update security: ${passed} passed, ${skipped} platform skips`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
