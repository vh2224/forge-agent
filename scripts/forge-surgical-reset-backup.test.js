#!/usr/bin/env node
'use strict';

// S02/T03 contract suite: exclusive verified backup + surgical reset limited to
// claimed paths. Temporary-root contract tests with REAL git repositories (and
// SVN when the executable exists). Every fixture lives under one owned temporary
// directory removed in `finally`; no operator root, owner or shared ref is used.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const reset = require('./forge-surgical-reset');
const vcs = require('./forge-vcs');
const roots = require('./forge-code-roots');

const EXPECTED_CODES = [
  'reset-unclaimed-change', 'reset-concrete-claims-required', 'backup-conflict', 'backup-target-invalid',
  'backup-unverified', 'reset-target-changed', 'reset-partial',
  'reset-overlap', 'baseline-moved', 'reset-pre-dirty-changed', 'reset-unverified',
  'reset-input-invalid',
];
const LEGACY_EXPORTS = ['reconcileFailedAttempt', 'isGsdPath', 'isInstallArtifactPath', 'parsePorcelainZ', 'parseNameStatusZ',
  'parseSvnBaseline', 'captureAttemptSnapshot', 'captureMultiAttemptSnapshot', 'hashObject', 'captureSnapshot',
  'computePostChanges', 'computeResetTarget', 'computeLeftover', 'executeReset', 'verifyReset', 'pruneEmptyParents',
  'writeJsonAtomic', 'readState', 'initState', 'initReadOnlyState', 'updateState', 'resetFromState',
  'resetMultiFromState', 'resetFailedAttempt'];

const CRLF_BASE = Buffer.from('line one\r\nline two\r\n', 'utf8');
const CRLF_WORKER = Buffer.from('worker one\r\nworker two\r\n\r\n', 'utf8');
const BIN_BASE = Buffer.from([0, 1, 2, 255, 254, 13, 10, 0, 7]);
const BIN_WORKER = Buffer.from([255, 0, 13, 13, 10, 10, 0, 128, 64, 1]);

const lab = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-reset-backup '));
const results = [];
let counter = 0;

function sh(cwd, bin, args) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 60000 });
  assert.strictEqual(result.status, 0, `${bin} ${args.join(' ')}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
const git = (cwd, args) => sh(cwd, 'git', args);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const svnAvailable = spawnSync('svn', ['--version', '--quiet'], { encoding: 'utf8', windowsHide: true }).status === 0
  && spawnSync('svnadmin', ['--version', '--quiet'], { encoding: 'utf8', windowsHide: true }).status === 0;

function gitRoot(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'user.email', 'fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Fixture']);
  write(path.join(dir, 'tracked.txt'), 'base\n');
  write(path.join(dir, 'crlf.txt'), CRLF_BASE);
  write(path.join(dir, 'bin.dat'), BIN_BASE);
  write(path.join(dir, 'src', 'keep.txt'), 'keep\n');
  write(path.join(dir, 'unclaimed.txt'), 'unclaimed base\n');
  write(path.join(dir, '.gitattributes'), '* -text\n');
  write(path.join(dir, '.gitignore'), 'ignored.log\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'fixture']);
  return fs.realpathSync.native(dir);
}

/** Two git roots + owner, operator pre-dirty/ignored/.gsd bytes, then initState. */
function fixture(label, options = {}) {
  const base = path.join(lab, `${label}-${++counter}`);
  const owner = path.join(base, 'owner');
  write(path.join(owner, '.gsd', 'STATE.md'), 'owner state\n');
  const a = gitRoot(path.join(base, 'roots', 'a'));
  const b = gitRoot(path.join(base, 'roots', 'b'));
  for (const dir of [a, b]) {
    write(path.join(dir, 'tracked.txt'), 'operator edit\r\n');
    write(path.join(dir, 'operator.txt'), 'operator untracked\n');
    write(path.join(dir, 'ignored.log'), 'ignored bytes\n');
    write(path.join(dir, '.gsd', 'events.jsonl'), '{"before":true}\n');
  }
  const contract = roots.validateContract({ schema_version: 2, owner: fs.realpathSync.native(owner), primary_root_id: 'alpha',
    code_roots: [{ id: 'alpha', path: a }, { id: 'beta', path: b }] });
  const stateFile = path.join(base, 'reset-state.json');
  reset.initState(stateFile, { cwd: a, attempt: `backup-${label}`, executionContract: contract });
  const f = { base, owner, a, b, contract, stateFile, backupDir: path.join(base, 'attempt.abandon', 'backup'),
    claims: [{ root_id: 'alpha', path: 'crlf.txt' }, { root_id: 'alpha', path: 'bin.dat' }, { root_id: 'alpha', path: 'src' },
      'beta::crlf.txt', 'beta::bin.dat', { root_id: 'beta', path: 'src' }] };
  if (options.worker !== false) worker(f);
  f.stateBytes = fs.readFileSync(stateFile);
  return f;
}

/** Worker effects inside the claims of both roots, plus excluded .gsd writes. */
function worker(f) {
  for (const dir of [f.a, f.b]) {
    write(path.join(dir, 'crlf.txt'), CRLF_WORKER);
    write(path.join(dir, 'bin.dat'), BIN_WORKER);
    fs.rmSync(path.join(dir, 'src', 'keep.txt'));
    write(path.join(dir, 'src', 'nested', 'new.txt'), 'worker new\r\n');
    write(path.join(dir, '.gsd', 'worker.json'), '{"worker":true}\n');
  }
}

/** Byte census of everything a claimed reset must never touch. */
function untouched(f) {
  const files = [path.join(f.owner, '.gsd', 'STATE.md')];
  for (const dir of [f.a, f.b]) {
    for (const rel of ['tracked.txt', 'operator.txt', 'ignored.log', 'unclaimed.txt', '.gsd/events.jsonl', '.gsd/worker.json']) {
      files.push(path.join(dir, rel));
    }
  }
  return files.map((file) => [file, read(file) && sha(read(file))]);
}

function treeOf(f) {
  return [f.a, f.b].map((dir) => ['crlf.txt', 'bin.dat', 'src/keep.txt', 'src/nested/new.txt']
    .map((rel) => { const bytes = read(path.join(dir, rel)); return bytes && sha(bytes); }));
}

function assertBaseline(f) {
  for (const dir of [f.a, f.b]) {
    assert(fs.readFileSync(path.join(dir, 'crlf.txt')).equals(CRLF_BASE), 'CRLF bytes restored exactly');
    assert(fs.readFileSync(path.join(dir, 'bin.dat')).equals(BIN_BASE), 'binary bytes restored exactly');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'keep.txt'), 'utf8'), 'keep\n');
    assert.strictEqual(fs.existsSync(path.join(dir, 'src', 'nested', 'new.txt')), false);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'tracked.txt'), 'utf8'), 'operator edit\r\n', 'pre-dirty preserved');
  }
}

function assertNoBackup(f) {
  assert.strictEqual(fs.existsSync(path.join(f.backupDir, 'manifest.json')), false, 'refusal creates no manifest');
}

function assertStateUntouched(f) {
  assert(fs.readFileSync(f.stateFile).equals(f.stateBytes), 'state file bytes identical');
}

const ok = () => {};

function test(name, fn) {
  const started = Date.now();
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${error && error.stack}`);
  }
}

try {
  test('T0 BACKUP_RESET_CODES frozen pin and legacy exports intact', () => {
    assert(Object.isFrozen(reset.BACKUP_RESET_CODES));
    assert.deepStrictEqual([...reset.BACKUP_RESET_CODES], EXPECTED_CODES);
    for (const name of LEGACY_EXPORTS) assert.strictEqual(typeof reset[name], 'function', name);
    assert.strictEqual(typeof reset.backupResetTargets, 'function');
    assert.strictEqual(typeof reset.resetClaimedAttempt, 'function');
    assert.strictEqual(reset.isGsdPath('.gsd/x'), true);
    assert.strictEqual(reset.isInstallArtifactPath('a/node_modules/b'), true);
  });

  test('T1 backup writes exclusive blobs and manifest, re-reads them and keeps CRLF/binary bytes', () => {
    const f = fixture('backup');
    const before = untouched(f), tree = treeOf(f);
    const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.strictEqual(backup.ok, true, JSON.stringify(backup));
    assert.strictEqual(backup.manifest_file, path.join(f.backupDir, 'manifest.json'));
    const manifestBytes = fs.readFileSync(backup.manifest_file);
    assert.strictEqual(sha(manifestBytes), backup.manifest_sha256);
    const manifest = JSON.parse(manifestBytes);
    assert.strictEqual(manifest.schema_version, 1);
    assert.strictEqual(manifest.state_file_sha256, sha(f.stateBytes));
    assert.strictEqual(manifest.contract_sha256, roots.digest(JSON.parse(f.stateBytes).execution_contract));
    assert.deepStrictEqual(manifest.roots.map((row) => [row.root_id, row.vcs]), [['alpha', 'git'], ['beta', 'git']]);
    for (const row of manifest.roots) {
      assert.strictEqual(row.start_sha, JSON.parse(f.stateBytes).repos.find((r) => r.root_id === row.root_id).start_sha);
      assert.deepStrictEqual(row.restore, [
        { path: 'bin.dat', sha256: sha(BIN_WORKER), size: BIN_WORKER.length },
        { path: 'crlf.txt', sha256: sha(CRLF_WORKER), size: CRLF_WORKER.length },
        { path: 'src/keep.txt', sha256: null, size: 0 },
      ]);
      const added = Buffer.from('worker new\r\n');
      assert.deepStrictEqual(row.remove, [{ path: 'src/nested/new.txt', sha256: sha(added), size: added.length }]);
    }
    assert.strictEqual(backup.entries, 8);
    assert(fs.readFileSync(path.join(f.backupDir, 'blobs', sha(CRLF_WORKER))).equals(CRLF_WORKER), 'CRLF blob byte-identical');
    assert(fs.readFileSync(path.join(f.backupDir, 'blobs', sha(BIN_WORKER))).equals(BIN_WORKER), 'binary blob byte-identical');
    for (const name of fs.readdirSync(path.join(f.backupDir, 'blobs'))) {
      const file = path.join(f.backupDir, 'blobs', name);
      const stat = fs.lstatSync(file);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      assert.strictEqual(sha(fs.readFileSync(file)), name);
      if (process.platform !== 'win32') assert.strictEqual(stat.mode & 0o777, 0o600);
    }
    assert.deepStrictEqual(untouched(f), before, 'backup writes no byte in roots or owner');
    assert.deepStrictEqual(treeOf(f), tree);
    assertStateUntouched(f);
    // Idempotent: same content, same manifest sha, nothing rewritten.
    const mtime = fs.statSync(backup.manifest_file).mtimeMs;
    const again = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.deepStrictEqual(again, backup);
    assert.strictEqual(fs.statSync(backup.manifest_file).mtimeMs, mtime);
  });

  test('T2 divergent manifest or blob is backup-conflict and a tampered backup never resets', () => {
    const f = fixture('conflict');
    const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.strictEqual(backup.ok, true, JSON.stringify(backup));
    // A different claimed content after the backup produces another manifest: conflict.
    write(path.join(f.a, 'src', 'nested', 'new.txt'), 'worker changed again\n');
    const changed = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.strictEqual(changed.reason_code, 'backup-conflict', JSON.stringify(changed));
    assert.strictEqual(sha(fs.readFileSync(backup.manifest_file)), backup.manifest_sha256, 'existing manifest intact');
    // ... and the reset refuses because live bytes are no longer the backed-up bytes.
    const tree = treeOf(f);
    const refused = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
    assert.strictEqual(refused.reason_code, 'reset-target-changed', JSON.stringify(refused));
    assert.deepStrictEqual(refused.altered, []);
    assert.deepStrictEqual(treeOf(f), tree, 'no mutation');
    write(path.join(f.a, 'src', 'nested', 'new.txt'), 'worker new\r\n');
    const backedUp = treeOf(f);
    // Blob bytes replaced (same name, other content): re-backup conflicts, reset is unverified.
    const blob = path.join(f.backupDir, 'blobs', sha(CRLF_WORKER));
    fs.rmSync(blob); fs.writeFileSync(blob, 'tampered');
    assert.strictEqual(reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims }).reason_code, 'backup-conflict');
    const tampered = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
    assert.strictEqual(tampered.reason_code, 'backup-unverified', JSON.stringify(tampered));
    fs.rmSync(blob); fs.writeFileSync(blob, CRLF_WORKER);
    // Manifest digest handle mismatch.
    const wrong = reset.resetClaimedAttempt(f.stateFile, { backup: { ...backup, manifest_sha256: sha('x') }, claims: f.claims, assertUnchanged: ok });
    assert.strictEqual(wrong.reason_code, 'backup-unverified');
    assert.deepStrictEqual(treeOf(f), backedUp, 'no mutation after unverified backup');
    // With the backup intact again the same handle resets and proves both roots.
    const done = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
    assert.strictEqual(done.ok, true, JSON.stringify(done));
    assertBaseline(f);
    assertStateUntouched(f);
  });

  test('T3 backupDir inside owner or a root, link components and hardlinks are refused', () => {
    const f = fixture('links');
    const tree = treeOf(f), before = untouched(f);
    for (const dir of [path.join(f.owner, 'backup'), path.join(f.a, 'backup'), path.join(f.b, 'src', 'backup'), path.dirname(f.base), 'relative/backup']) {
      const refused = reset.backupResetTargets(f.stateFile, { backupDir: dir, claims: f.claims });
      assert.strictEqual(refused.reason_code, 'backup-target-invalid', `${dir}: ${JSON.stringify(refused)}`);
    }
    assert.strictEqual(fs.existsSync(path.join(f.a, 'backup')), false, 'no directory created inside a root');
    // Junction (win32) / directory symlink (posix) as a backupDir component.
    const real = path.join(f.base, 'real-dir'); fs.mkdirSync(real);
    const junction = path.join(f.base, 'junction');
    fs.symlinkSync(real, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const viaJunction = reset.backupResetTargets(f.stateFile, { backupDir: path.join(junction, 'backup'), claims: f.claims });
    assert.strictEqual(viaJunction.reason_code, 'backup-target-invalid');
    assert.deepStrictEqual(fs.readdirSync(real), [], 'nothing written through the junction');
    // A junction pointing INTO a root is refused as well.
    const intoRoot = path.join(f.base, 'into-root');
    fs.symlinkSync(f.a, intoRoot, process.platform === 'win32' ? 'junction' : 'dir');
    assert.strictEqual(reset.backupResetTargets(f.stateFile, { backupDir: path.join(intoRoot, 'b'), claims: f.claims }).reason_code, 'backup-target-invalid');
    assert.deepStrictEqual(treeOf(f), tree); assert.deepStrictEqual(untouched(f), before);
    // Hardlinked blob: re-backup is backup-target-invalid, reset is backup-unverified.
    const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.strictEqual(backup.ok, true, JSON.stringify(backup));
    const alias = path.join(f.base, 'blob-alias');
    fs.linkSync(path.join(f.backupDir, 'blobs', sha(BIN_WORKER)), alias);
    assert.strictEqual(reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims }).reason_code, 'backup-target-invalid');
    assert.strictEqual(reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok }).reason_code, 'backup-unverified');
    fs.rmSync(alias);
    const manifestAlias = path.join(f.base, 'manifest-alias');
    fs.linkSync(backup.manifest_file, manifestAlias);
    assert.strictEqual(reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok }).reason_code, 'backup-unverified');
    fs.rmSync(manifestAlias);
    // Hardlinked reset target inside a claimed path.
    const outside = path.join(f.base, 'outside.txt'); fs.writeFileSync(outside, 'outside bytes\n');
    fs.linkSync(outside, path.join(f.a, 'src', 'hard.txt'));
    const hard = reset.backupResetTargets(f.stateFile, { backupDir: path.join(f.base, 'other-backup'), claims: f.claims });
    assert.strictEqual(hard.reason_code, 'backup-target-invalid', JSON.stringify(hard));
    assert.strictEqual(fs.existsSync(path.join(f.base, 'other-backup')), false, 'refusal creates no backup directory');
    fs.rmSync(path.join(f.a, 'src', 'hard.txt'));
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside bytes\n');
    // File symlink as a reset target (EPERM without Developer Mode is labelled).
    let symlinkLabel = 'exercised';
    try { fs.symlinkSync(outside, path.join(f.a, 'src', 'link.txt'), 'file'); } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
      symlinkLabel = `SKIP platform: file symlink creation ${error.code}`;
    }
    if (symlinkLabel === 'exercised') {
      const linked = reset.backupResetTargets(f.stateFile, { backupDir: path.join(f.base, 'link-backup'), claims: f.claims });
      assert.strictEqual(linked.reason_code, 'backup-target-invalid', JSON.stringify(linked));
      fs.rmSync(path.join(f.a, 'src', 'link.txt'));
    }
    console.log(`ENV file-symlink-target ${JSON.stringify(symlinkLabel)}`);
    assertStateUntouched(f);
  });

  test('T4 glob claim, missing claims, unclaimed change and overlap refuse before any byte', () => {
    const f = fixture('claims');
    const tree = treeOf(f), before = untouched(f);
    const cases = [
      [[...f.claims, { root_id: 'alpha', path: 'src/*.txt' }], 'reset-concrete-claims-required'],
      [['beta::src/**'], 'reset-concrete-claims-required'],
      [['alpha::cr?f.txt'], 'reset-concrete-claims-required'],
      [[], 'reset-concrete-claims-required'],
      [undefined, 'reset-concrete-claims-required'],
      [['alpha::.gsd/events.jsonl'], 'reset-concrete-claims-required'],
      [['unknown::crlf.txt'], 'reset-concrete-claims-required'],
      [['alpha::../escape.txt'], 'reset-concrete-claims-required'],
      [f.claims.filter((claim) => claim !== 'beta::bin.dat'), 'reset-unclaimed-change'],
    ];
    for (const [claims, code] of cases) {
      const refused = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims });
      assert.strictEqual(refused.reason_code, code, `${JSON.stringify(claims)} -> ${JSON.stringify(refused)}`);
      assertNoBackup(f);
    }
    const unclaimed = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims.filter((claim) => claim !== 'beta::bin.dat') });
    assert.deepStrictEqual([unclaimed.root_id, unclaimed.paths], ['beta', ['bin.dat']]);
    // Change outside every claim (tracked + untracked).
    write(path.join(f.b, 'unclaimed.txt'), 'worker wrote unclaimed\n');
    write(path.join(f.a, 'stray.txt'), 'stray\n');
    const stray = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.strictEqual(stray.reason_code, 'reset-unclaimed-change');
    assert.deepStrictEqual([stray.root_id, stray.paths], ['alpha', ['stray.txt']], 'first root refused, no root mutated');
    fs.rmSync(path.join(f.a, 'stray.txt'));
    const strayB = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.deepStrictEqual([strayB.reason_code, strayB.root_id, strayB.paths], ['reset-unclaimed-change', 'beta', ['unclaimed.txt']]);
    // Without a verified backup the reset refuses even with valid claims.
    assert.strictEqual(reset.resetClaimedAttempt(f.stateFile, { backup: { manifest_file: path.join(f.backupDir, 'manifest.json'), manifest_sha256: sha('') },
      claims: f.claims, assertUnchanged: ok }).reason_code, 'backup-unverified');
    write(path.join(f.b, 'unclaimed.txt'), 'unclaimed base\n');
    // Overlap: the worker also wrote a pre-dirty file.
    write(path.join(f.a, 'tracked.txt'), 'worker overwrote operator\n');
    const overlap = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: [...f.claims, 'alpha::tracked.txt'] });
    assert.strictEqual(overlap.reason_code, 'reset-overlap', JSON.stringify(overlap));
    assertNoBackup(f);
    write(path.join(f.a, 'tracked.txt'), 'operator edit\r\n');
    assert.deepStrictEqual(treeOf(f), tree); assert.deepStrictEqual(untouched(f), before);
    assertStateUntouched(f);
  });

  test('T5 state schema, contract and baseline are checked before any byte', () => {
    const f = fixture('state');
    const tree = treeOf(f);
    const legacy = path.join(f.base, 'legacy-state.json');
    reset.initState(legacy, { cwd: f.a, attempt: 'legacy' });
    assert.strictEqual(reset.backupResetTargets(legacy, { backupDir: f.backupDir, claims: f.claims }).reason_code, 'reset-input-invalid');
    assert.strictEqual(reset.backupResetTargets(path.join(f.base, 'missing.json'), { backupDir: f.backupDir, claims: f.claims }).reason_code, 'reset-input-invalid');
    assert.strictEqual(reset.resetClaimedAttempt(legacy, { backup: {}, claims: f.claims, assertUnchanged: ok }).reason_code, 'reset-input-invalid');
    assert.strictEqual(reset.resetClaimedAttempt(f.stateFile, { backup: {}, claims: f.claims }).reason_code, 'reset-input-invalid');
    // Pre-dirty bytes changed in a way the worker could not explain: the operator file vanished.
    const operator = path.join(f.b, 'operator.txt');
    fs.rmSync(operator);
    const vanished = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert(['reset-overlap', 'reset-pre-dirty-changed'].includes(vanished.reason_code), JSON.stringify(vanished));
    assertNoBackup(f);
    write(operator, 'operator untracked\n');
    // Baseline moved (a commit in beta).
    write(path.join(f.b, 'committed.txt'), 'moved\n');
    git(f.b, ['add', 'committed.txt']); git(f.b, ['commit', '-qm', 'move']);
    const moved = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.deepStrictEqual([moved.reason_code, moved.root_id], ['baseline-moved', 'beta']);
    assertNoBackup(f);
    assert.deepStrictEqual(treeOf(f), tree);
    assertStateUntouched(f);
  });

  test('T6 claimed reset of two roots is proven, the remainder and the state stay byte for byte', () => {
    const f = fixture('reset');
    const before = untouched(f);
    const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.strictEqual(backup.ok, true, JSON.stringify(backup));
    const calls = [], progress = [];
    const result = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims,
      assertUnchanged(observation) { assert(Object.isFrozen(observation)); calls.push({ ...observation }); },
      onProgress(row) { progress.push(row); } });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.verified, true);
    assert.deepStrictEqual(result.roots_done, ['alpha', 'beta']);
    assert.deepStrictEqual(result.pending_roots, []);
    const paths = ['bin.dat', 'crlf.txt', 'src/keep.txt', 'src/nested/new.txt'];
    assert.deepStrictEqual(result.altered, [{ root_id: 'alpha', paths }, { root_id: 'beta', paths }]);
    assert.deepStrictEqual(calls, [{ phase: 'before-first-mutation', roots: ['alpha', 'beta'] },
      { phase: 'before-root', root_id: 'alpha' }, { phase: 'before-root', root_id: 'beta' }]);
    assert.deepStrictEqual(progress, [{ roots_done: ['alpha'], pending_roots: ['beta'] }, { roots_done: ['alpha', 'beta'], pending_roots: [] }]);
    assertBaseline(f);
    assert.deepStrictEqual(untouched(f), before, 'unclaimed, pre-dirty, ignored, .gsd and owner bytes identical');
    assertStateUntouched(f);
    for (const dir of [f.a, f.b]) {
      const state = JSON.parse(f.stateBytes).repos.find((repo) => roots.key(repo.code_dir) === roots.key(dir));
      assert.deepStrictEqual(reset.verifyReset(dir, state.start_sha, state.pre_dirty), { verified: true, leftover: [] });
    }
    assert.strictEqual(sha(fs.readFileSync(backup.manifest_file)), backup.manifest_sha256, 'manifest kept after reset');
    // Re-running on a reset tree is an idempotent proof with nothing altered.
    const again = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
    assert.strictEqual(again.ok, true, JSON.stringify(again));
    assert.deepStrictEqual(again.altered, [{ root_id: 'alpha', paths: [] }, { root_id: 'beta', paths: [] }]);
    assert.deepStrictEqual(again.already_reset.map((row) => row.paths), [paths, paths]);
    assertStateUntouched(f);
  });

  test('T7 assertUnchanged throwing before the first mutation changes nothing', () => {
    const f = fixture('assert-first');
    const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    const tree = treeOf(f);
    const result = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims,
      assertUnchanged() { throw Object.assign(new Error('C:\\Users\\private secret'), { code: 'abandon-changed-after-proof' }); } });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason_code, 'reset-target-changed');
    assert.strictEqual(result.assert_code, 'abandon-changed-after-proof');
    assert.deepStrictEqual([result.roots_done, result.pending_roots, result.altered], [[], ['alpha', 'beta'], []]);
    assert(!JSON.stringify(result).includes('private'), 'caller message never echoed');
    assert.deepStrictEqual(treeOf(f), tree);
    assertStateUntouched(f);
  });

  test('T8 assertUnchanged throwing between roots is reset-partial and the same backup resumes', () => {
    const f = fixture('partial');
    const before = untouched(f);
    const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    const manifestBytes = fs.readFileSync(backup.manifest_file);
    const blobs = fs.readdirSync(path.join(f.backupDir, 'blobs')).map((name) => [name, sha(fs.readFileSync(path.join(f.backupDir, 'blobs', name)))]);
    const betaTree = treeOf(f)[1];
    const partial = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims,
      assertUnchanged(observation) { if (observation.root_id === 'beta') throw Object.assign(new Error('x'), { code: 'fixture-between-roots' }); } });
    const paths = ['bin.dat', 'crlf.txt', 'src/keep.txt', 'src/nested/new.txt'];
    assert.strictEqual(partial.ok, false);
    assert.strictEqual(partial.reason_code, 'reset-partial', JSON.stringify(partial));
    assert.strictEqual(partial.cause_code, 'reset-target-changed');
    assert.deepStrictEqual([partial.roots_done, partial.pending_roots], [['alpha'], ['beta']]);
    assert.deepStrictEqual(partial.altered, [{ root_id: 'alpha', paths }]);
    assert.deepStrictEqual(treeOf(f)[1], betaTree, 'pending root untouched');
    assert(fs.readFileSync(backup.manifest_file).equals(manifestBytes), 'manifest intact');
    assert.deepStrictEqual(fs.readdirSync(path.join(f.backupDir, 'blobs')).map((name) => [name, sha(fs.readFileSync(path.join(f.backupDir, 'blobs', name)))]), blobs, 'blobs intact');
    assertStateUntouched(f);
    // onProgress failure after alpha (simulated crash between roots) on the resumed run.
    const crashed = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok,
      onProgress(row) { if (row.roots_done.length === 1) throw new Error('fixture-crash'); } });
    assert.deepStrictEqual([crashed.reason_code, crashed.roots_done, crashed.pending_roots], ['reset-partial', ['alpha'], ['beta']]);
    assert.deepStrictEqual(crashed.already_reset, [{ root_id: 'alpha', paths }], 'resumption sees alpha already at baseline');
    // Resume with the same backup: proves both roots.
    const resumed = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
    assert.strictEqual(resumed.ok, true, JSON.stringify(resumed));
    assert.deepStrictEqual(resumed.roots_done, ['alpha', 'beta']);
    assert.deepStrictEqual(resumed.altered, [{ root_id: 'alpha', paths: [] }, { root_id: 'beta', paths }]);
    assertBaseline(f);
    assert.deepStrictEqual(untouched(f), before);
    assertStateUntouched(f);
  });

  test('T9 change after backup, new target, baseline move and edited state refuse the reset with zero mutation', () => {
    const f = fixture('after-backup');
    const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
    assert.strictEqual(backup.ok, true);
    const tree = treeOf(f);
    write(path.join(f.b, 'src', 'late.txt'), 'late worker write\n');
    const late = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
    assert.deepStrictEqual([late.reason_code, late.root_id, late.altered], ['reset-target-changed', 'beta', []]);
    fs.rmSync(path.join(f.b, 'src', 'late.txt'));
    write(path.join(f.a, 'bin.dat'), Buffer.from([9, 9, 9]));
    assert.strictEqual(reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok }).reason_code, 'reset-target-changed');
    write(path.join(f.a, 'bin.dat'), BIN_WORKER);
    // Claims narrower than the manifest: the reset never reverts an unclaimed path.
    const narrow = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims.filter((claim) => claim !== 'beta::crlf.txt'), assertUnchanged: ok });
    assert.deepStrictEqual([narrow.reason_code, narrow.paths], ['reset-unclaimed-change', ['crlf.txt']]);
    // Edited state file (one byte appended): the manifest no longer binds it.
    fs.appendFileSync(f.stateFile, ' ');
    assert.strictEqual(reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok }).reason_code, 'backup-unverified');
    fs.writeFileSync(f.stateFile, f.stateBytes);
    write(path.join(f.a, 'committed.txt'), 'moved\n');
    git(f.a, ['add', 'committed.txt']); git(f.a, ['commit', '-qm', 'move']);
    const moved = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
    assert.deepStrictEqual([moved.reason_code, moved.root_id], ['baseline-moved', 'alpha']);
    assert.deepStrictEqual(treeOf(f), tree, 'no mutation');
    assertStateUntouched(f);
  });

  test('T10 failed post-condition is reset-unverified, a later-root failure is reset-partial with actual altered paths', () => {
    const original = vcs.restoreAndRemove;
    try {
      const f = fixture('unverified');
      const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims: f.claims });
      // Seam: the real restore runs, then a claimed file reappears (a writer that was not stopped).
      vcs.restoreAndRemove = function patched(cwd, ...rest) {
        const done = original.call(this, cwd, ...rest);
        if (roots.key(cwd) === roots.key(f.a)) write(path.join(cwd, 'src', 'nested', 'new.txt'), 'writer still alive\n');
        return done;
      };
      const unverified = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
      assert.strictEqual(unverified.reason_code, 'reset-unverified', JSON.stringify(unverified));
      assert.deepStrictEqual([unverified.roots_done, unverified.pending_roots], [[], ['alpha', 'beta']]);
      assert.deepStrictEqual(unverified.altered, [{ root_id: 'alpha', paths: ['bin.dat', 'crlf.txt', 'src/keep.txt'], exact: true }]);
      assert.notStrictEqual(unverified.altered.length, 0, 'never declares absence of effects');
      vcs.restoreAndRemove = original;
      fs.rmSync(path.join(f.a, 'src', 'nested', 'new.txt'));
      // Second root throws mid-way after the first root was proven.
      vcs.restoreAndRemove = function patched(cwd, baseline, target, opts) {
        if (roots.key(cwd) !== roots.key(f.b)) return original.call(this, cwd, baseline, target, opts);
        original.call(this, cwd, baseline, { ...target, remove: [] }, opts);
        return { ok: false, restored: [], removed: [], error: 'fixture-remove-failed' };
      };
      // alpha is already at baseline except the removed file above; the backup still covers it.
      const partial = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
      assert.strictEqual(partial.reason_code, 'reset-partial', JSON.stringify(partial));
      assert.deepStrictEqual([partial.roots_done, partial.pending_roots], [['alpha'], ['beta']]);
      assert.deepStrictEqual(partial.altered[1], { root_id: 'beta', paths: ['bin.dat', 'crlf.txt', 'src/keep.txt'], exact: true });
      assert.strictEqual(fs.existsSync(path.join(f.b, 'src', 'nested', 'new.txt')), true);
      assert.strictEqual(sha(fs.readFileSync(backup.manifest_file)), backup.manifest_sha256);
      vcs.restoreAndRemove = original;
      const resumed = reset.resetClaimedAttempt(f.stateFile, { backup, claims: f.claims, assertUnchanged: ok });
      assert.strictEqual(resumed.ok, true, JSON.stringify(resumed));
      assert.deepStrictEqual(resumed.altered[1], { root_id: 'beta', paths: ['src/nested/new.txt'] });
      assertBaseline(f);
      assertStateUntouched(f);
    } finally { vcs.restoreAndRemove = original; }
  });

  test('T11 Windows separators and case in claims are normalized by forge-code-roots', () => {
    const f = fixture('normalize');
    const claims = process.platform === 'win32'
      ? ['alpha::CRLF.TXT', 'alpha::Bin.Dat', 'alpha::SRC', 'beta::crlf.txt', 'beta::bin.dat', 'beta::Src\\Nested\\New.txt', 'beta::src\\keep.txt']
      : ['alpha::crlf.txt', 'alpha::bin.dat', 'alpha::src', 'beta::crlf.txt', 'beta::bin.dat', 'beta::src\\nested\\new.txt', 'beta::src\\keep.txt'];
    const backup = reset.backupResetTargets(f.stateFile, { backupDir: f.backupDir, claims });
    assert.strictEqual(backup.ok, true, JSON.stringify(backup));
    const result = reset.resetClaimedAttempt(f.stateFile, { backup, claims, assertUnchanged: ok });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assertBaseline(f);
    console.log(`ENV claim-normalization ${JSON.stringify({ platform: process.platform, case_folded: process.platform === 'win32' })}`);
  });

  test('T12 SVN roots reset only claimed paths and a pre-dirty property change refuses', () => {
    if (!svnAvailable) { console.log('ENV svn "SKIP platform: svn/svnadmin executable unavailable"'); return; }
    const fixtures = require('./forge-code-roots.test');
    const f = fixtures.fixture('svn');
    try {
      const stateFile = path.join(f.dir, 'svn-reset.json');
      for (const dir of [f.a, f.b]) fs.writeFileSync(path.join(dir, 'operator.txt'), 'operator svn dirty\n');
      reset.initState(stateFile, { cwd: f.a, attempt: 'svn-claimed', executionContract: f.contract });
      const stateBytes = fs.readFileSync(stateFile);
      for (const dir of [f.a, f.b]) {
        fs.writeFileSync(path.join(dir, 'same.txt'), 'worker svn bytes\r\n');
        fs.writeFileSync(path.join(dir, 'worker.txt'), 'worker svn new\n');
      }
      const claims = ['alpha::same.txt', 'alpha::worker.txt', 'beta::same.txt', 'beta::worker.txt'];
      const backupDir = path.join(f.dir, 'svn.abandon', 'backup');
      const unclaimed = reset.backupResetTargets(stateFile, { backupDir, claims: claims.slice(0, 3) });
      assert.deepStrictEqual([unclaimed.reason_code, unclaimed.root_id], ['reset-unclaimed-change', 'beta'], JSON.stringify(unclaimed));
      const backup = reset.backupResetTargets(stateFile, { backupDir, claims });
      assert.strictEqual(backup.ok, true, JSON.stringify(backup));
      const result = reset.resetClaimedAttempt(stateFile, { backup, claims, assertUnchanged: ok });
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      for (const dir of [f.a, f.b]) {
        assert.strictEqual(fs.readFileSync(path.join(dir, 'same.txt'), 'utf8'), 'before\n');
        assert.strictEqual(fs.existsSync(path.join(dir, 'worker.txt')), false);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'operator.txt'), 'utf8'), 'operator svn dirty\n');
      }
      assert(fs.readFileSync(stateFile).equals(stateBytes), 'svn state untouched');
      // Pre-dirty property divergence (content hash unchanged) refuses before any byte.
      const propState = path.join(f.dir, 'svn-prop.json');
      fs.writeFileSync(path.join(f.b, 'same.txt'), 'operator dirty bytes');
      reset.initState(propState, { cwd: f.a, attempt: 'svn-prop', executionContract: f.contract });
      fixtures.command('svn', ['propset', 'fixture-prop', 'worker value', 'same.txt'], f.b);
      const prop = reset.backupResetTargets(propState, { backupDir: path.join(f.dir, 'prop-backup'), claims });
      assert.strictEqual(prop.reason_code, 'reset-pre-dirty-changed', JSON.stringify(prop));
      assert.strictEqual(fs.existsSync(path.join(f.dir, 'prop-backup')), false);
      assert.strictEqual(fs.readFileSync(path.join(f.b, 'same.txt'), 'utf8'), 'operator dirty bytes');
      console.log(`ENV svn-pre-dirty-property ${JSON.stringify(prop.reason_code)}`);
    } finally { f.cleanup(); }
  });
} finally {
  fs.rmSync(lab, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.ok);
console.log(`${results.length - failed.length}/${results.length} forge-surgical-reset-backup cases passed`);
if (failed.length) process.exitCode = 1;
